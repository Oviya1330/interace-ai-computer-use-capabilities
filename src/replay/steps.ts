/**
 * Executes ONE artifact step against a surface. Shared by session bootstrap (login flow),
 * replay, and condition handlers. No LLM anywhere in here.
 */
import type { Step, Expectation } from "../core/schema.js";
import type { Params, SecretResolver } from "../core/template.js";
import { describeValue, resolveValue, templateToRegex } from "../core/template.js";
import { RunFailure } from "../core/errors.js";
import type { Surface, Resolved, DialogRecord } from "../surface/types.js";
import type { PolicyContext, PolicyGate, Decision, ProposedAction } from "../policy/policy.js";
import type { EventSink } from "../core/events.js";
import type { Resolution } from "../core/result.js";
import { parseValue, type ParsedValue } from "./parse.js";
import { truncate } from "../core/util.js";

export interface StepContext {
  surface: Surface;
  policy: PolicyGate;
  policyCtx: PolicyContext;
  params: Params;
  secrets: SecretResolver;
  events: EventSink;
  defaultTimeoutMs: number;
  /** Called when the gate requires confirmation. Return true to proceed. */
  confirm?: (step: Step, decision: Extract<Decision, { verdict: "confirm" }>) => Promise<boolean>;
  /** Step label for events (e.g. "login-submit" vs "3/7"). */
  label?: string;
}

export interface StepOutcome {
  resolution?: Resolution;
  resolvedElement?: import("../surface/types.js").ElementInfo | null;
  dialogs: DialogRecord[];
  extracted?: { output: string; raw: string; value: ParsedValue };
  expectations: Array<{ expectation: Expectation; ok: boolean; observed: string }>;
}

function describeExpectation(e: Expectation): string {
  switch (e.kind) {
    case "url":
      return `url matches ${e.pattern}`;
    case "text":
      return `text "${truncate(e.text, 60)}" ${e.present === false ? "absent" : "present"}${e.frame ? ` in ${e.frame.join("/")}` : ""}`;
    case "title":
      return `title matches ${e.pattern}`;
    case "target":
      return `${e.target.description} ${e.state}`;
    case "http_status":
      return `http status in [${e.min ?? "*"}, ${e.max ?? "*"}]`;
    case "dialog":
      return `dialog${e.messagePattern ? ` matching ${e.messagePattern}` : ""}`;
    case "all":
      return `all of: ${e.of.map(describeExpectation).join("; ")}`;
    case "any":
      return `any of: ${e.of.map(describeExpectation).join("; ")}`;
  }
}
export { describeExpectation };

export async function executeStep(step: Step, ctx: StepContext): Promise<StepOutcome> {
  const { surface, events, params } = ctx;
  const timeoutMs = step.timeoutMs ?? ctx.defaultTimeoutMs;
  const label = ctx.label ?? step.id;
  const outcome: StepOutcome = { dialogs: [], expectations: [] };

  // 1. Resolve the target (stable, multi-strategy).
  let resolved: Resolved | undefined;
  if ("target" in step) {
    resolved = await surface.resolve(step.target, params, { timeoutMs });
    outcome.resolution = resolved.resolution;
    outcome.resolvedElement = resolved.element;
    events.emit(
      "step.resolve",
      `[${label}] resolved ${step.target.description} via ${resolved.resolution.strategy} (tier ${resolved.resolution.tier}, ${resolved.resolution.ms}ms)`,
      {
        stepId: step.id,
        resolution: resolved.resolution,
      },
    );
  }

  // 2. Policy gate.
  const proposed = toProposedAction(step, ctx, resolved);
  if (proposed) {
    const decision = ctx.policy.evaluate(proposed, ctx.policyCtx);
    events.emit(
      "policy.decision",
      `[${label}] ${decision.verdict} (${decision.rule}, risk=${decision.risk})`,
      {
        stepId: step.id,
        action: proposed.kind,
        control: proposed.controlName,
        decision,
      },
    );
    if (decision.verdict === "deny") {
      throw new RunFailure(
        "POLICY_BLOCKED",
        `Policy denied ${step.kind} on ${proposed.controlName ?? proposed.url}: ${decision.reason}`,
      );
    }
    if (decision.verdict === "confirm") {
      if (!ctx.confirm)
        throw new RunFailure(
          "POLICY_BLOCKED",
          `${decision.reason}; no operator available to confirm`,
        );
      const ok = await ctx.confirm(step, decision);
      if (!ok)
        throw new RunFailure(
          "POLICY_BLOCKED",
          `Operator denied ${decision.risk} action "${proposed.controlName ?? step.kind}"`,
        );
    }
  }

  // 3. Act.
  surface.expectDialog(
    step.dialog
      ? {
          ...step.dialog,
          messagePattern: templateToRegex(step.dialog.messagePattern, params).source,
        }
      : null,
  );
  try {
    await act(step, ctx, resolved, outcome);
  } finally {
    surface.expectDialog(null);
  }
  await surface.settle();

  // 4. Dialogs: an unexpected one is a condition, not something to click through.
  outcome.dialogs = surface.takeDialogs();
  for (const d of outcome.dialogs) {
    events.emit(
      "dialog",
      `[${label}] ${d.type} dialog "${truncate(d.message, 80)}" → ${d.response}${d.expected ? " (expected)" : " (UNEXPECTED)"}`,
      {
        stepId: step.id,
        dialog: d,
      },
    );
  }
  const unexpected = outcome.dialogs.find((d) => !d.expected);
  if (unexpected) {
    throw new RunFailure(
      "UNEXPECTED_DIALOG",
      `Unexpected ${unexpected.type} dialog: "${unexpected.message}" (dismissed)`,
      {
        expected: step.dialog ? `dialog matching ${step.dialog.messagePattern}` : "no dialog",
        observed: unexpected.message,
      },
    );
  }

  // 5. Verify post-conditions.
  for (const e of step.expect) {
    const r = await surface.check(e, params, { timeoutMs });
    outcome.expectations.push({ expectation: e, ok: r.ok, observed: r.observed });
    events.emit(
      "step.expect",
      `[${label}] expect ${describeExpectation(e)} → ${r.ok ? "ok" : "FAILED"} (${truncate(r.observed, 120)})`,
      {
        stepId: step.id,
        ok: r.ok,
        observed: r.observed,
      },
    );
    if (!r.ok) {
      throw new RunFailure("EXPECTATION_FAILED", `Post-condition failed after "${step.name}"`, {
        expected: describeExpectation(e),
        observed: r.observed,
      });
    }
  }
  return outcome;
}

function toProposedAction(
  step: Step,
  ctx: StepContext,
  resolved?: Resolved,
): ProposedAction | null {
  const el = resolved?.element ?? null;
  const url =
    step.kind === "navigate"
      ? resolveValue(step.url, ctx.params, ctx.secrets).value
      : ctx.surface.currentUrl(resolved?.frame);
  const base = {
    url,
    controlName: el?.name || el?.labelText || el?.text || undefined,
    controlRole: el?.role,
    formSubmitLabels: el?.formSubmitLabels,
    declaredRisk: step.risk,
  };
  switch (step.kind) {
    case "navigate":
      return { kind: "navigate", ...base };
    case "click":
      return { kind: "click", ...base };
    case "type":
      return { kind: "type", ...base, pressEnter: step.pressEnter };
    case "select":
      return { kind: "select", ...base };
    case "press":
      return { kind: "press", ...base, pressEnter: step.key === "Enter" };
    case "extract":
      return { kind: "extract", ...base };
    case "wait":
    case "assert":
      return null;
  }
}

async function act(
  step: Step,
  ctx: StepContext,
  resolved: Resolved | undefined,
  outcome: StepOutcome,
): Promise<void> {
  const { surface, events, params, secrets } = ctx;
  const label = ctx.label ?? step.id;
  switch (step.kind) {
    case "navigate": {
      const { value } = resolveValue(step.url, params, secrets);
      events.emit("step.act", `[${label}] navigate ${value}`, { stepId: step.id, url: value });
      await surface.navigate(value);
      return;
    }
    case "click":
      events.emit("step.act", `[${label}] click ${step.target.description}`, { stepId: step.id });
      await surface.click(resolved!);
      return;
    case "type": {
      const { value, sensitive } = resolveValue(step.value, params, secrets);
      events.emit(
        "step.act",
        `[${label}] type ${sensitive ? "<secret>" : describeValue(step.value)} into ${step.target.description}`,
        {
          stepId: step.id,
          value: sensitive ? "[REDACTED:secret]" : value,
        },
      );
      await surface.type(resolved!, value, {
        clear: step.clear ?? true,
        pressEnter: step.pressEnter,
      });
      return;
    }
    case "select": {
      const { value } = resolveValue(step.value, params, secrets);
      events.emit("step.act", `[${label}] select "${value}" in ${step.target.description}`, {
        stepId: step.id,
        value,
      });
      await surface.select(resolved!, value);
      return;
    }
    case "press":
      events.emit("step.act", `[${label}] press ${step.key}`, { stepId: step.id, key: step.key });
      await surface.press(step.key);
      return;
    case "extract": {
      const raw = await surface.readText(resolved!);
      const value = parseValue(raw, step.parse);
      outcome.extracted = { output: step.output, raw, value };
      events.emit(
        "step.extract",
        `[${label}] extract ${step.output} = ${JSON.stringify(value)} (raw "${truncate(raw, 60)}")`,
        {
          stepId: step.id,
          output: step.output,
          value,
        },
      );
      return;
    }
    case "wait":
      if (step.ms) await new Promise((r) => setTimeout(r, step.ms));
      return;
    case "assert":
      return;
  }
}

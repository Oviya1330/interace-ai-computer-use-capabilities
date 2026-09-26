/**
 * Deterministic replay engine — the production execution path.
 *
 * Given a capability artifact + inputs, it:
 *   1. checks the artifact's integrity (an edited "approved" artifact is treated as draft),
 *   2. validates inputs against the artifact contract,
 *   3. bootstraps an authenticated session from the app profile,
 *   4. executes steps with pre-conditions, stable multi-strategy targeting and post-conditions,
 *   5. detects runtime conditions (business outcome / recoverable / hard failure) before every
 *      step and whenever a step fails, and responds deliberately,
 *   6. protects irreversible steps with a per-run cap and an idempotency ledger,
 *   7. optionally asks the model ONCE to re-find a lost control (assisted recovery, policy-checked),
 *   8. escalates to a human (live-session handoff) when it cannot safely proceed, and turns
 *      what the human did into a proposed condition,
 *   9. verifies the checkpoint and returns declared outputs.
 * The model is never in the decision loop; the only optional model call is bounded assist.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  AppProfile,
  Capability,
  Condition,
  Step,
  TenantBinding,
  Expectation,
  TargetStrategyKind,
  Target,
} from "../core/schema.js";
import { parameterize, type Params, type SecretResolver } from "../core/template.js";
import { BusinessOutcomeSignal, RunFailure, errorMessage } from "../core/errors.js";
import type {
  AssistRecord,
  ConditionHit,
  DriftReport,
  InterventionSummary,
  RunError,
  RunResult,
  StepReport,
} from "../core/result.js";
import type { Surface, Observation } from "../surface/types.js";
import type { PlaywrightSurface } from "../surface/playwright.js";
import type { PolicyGate, Decision, PolicyContext } from "../policy/policy.js";
import type { RunEvidence } from "../evidence/store.js";
import type { Redactor } from "../policy/redact.js";
import {
  InterventionBroker,
  InterventionTimeout,
  type InterventionRequest,
  type ResolutionKind,
} from "../hitl/broker.js";
import type { AuditLog } from "../hitl/audit.js";
import type { Decider } from "../agent/decider.js";
import { executeStep, describeExpectation, toProposedAction } from "./steps.js";
import { detectCondition, type Detected } from "./conditions.js";
import { ensureAuthenticated } from "./session.js";
import { parseValue } from "./parse.js";
import { IdempotencyLedger } from "./ledger.js";
import { checkIntegrity } from "../catalog/integrity.js";
import { ulid } from "../core/ids.js";
import { truncate } from "../core/util.js";

export interface ReplayOptions {
  capability: Capability;
  profile: AppProfile;
  tenant: TenantBinding;
  inputs: Record<string, unknown>;
  surface: Surface;
  policy: PolicyGate;
  secrets: SecretResolver;
  redactor: Redactor;
  evidence: RunEvidence;
  broker: InterventionBroker | null;
  /** The invoking agent/human explicitly authorised risky steps for this invocation. */
  approval?: { by: string; reason: string };
  /** Who asked for this invocation (four-eyes rule compares it with approval.by). */
  requestedBy?: string;
  /** Caller-supplied key that makes irreversible steps idempotent across invocations. */
  idempotencyKey?: string;
  ledger?: IdempotencyLedger | null;
  audit?: AuditLog | null;
  /** Bounded model-assisted recovery (null = off). */
  assist?: { decider: Decider; maxPerRun: number } | null;
  /** Restrict locator strategies for action steps (defaults to the profile's locator policy). */
  locatorKinds?: TargetStrategyKind[];
  runId?: string;
}

interface StepFrame {
  step: Step;
  index: number;
  report: StepReport;
}

type Verdict =
  | { kind: "next" }
  | { kind: "retry" }
  | { kind: "continue" }
  | { kind: "restart" }
  | { kind: "terminal"; result: RunResult };

export class ReplayEngine {
  private readonly runId: string;
  private readonly startedAt = new Date();
  private readonly steps: StepReport[] = [];
  private readonly recoveries: ConditionHit[] = [];
  private readonly interventions: InterventionSummary[] = [];
  private readonly assists: AssistRecord[] = [];
  private readonly proposedConditions: Condition[] = [];
  private readonly ledgerTouched: Array<{ key: string; stepId: string; status: string }> = [];
  private readonly tierHistogram: Record<string, number> = {};
  private readonly driftWarnings: string[] = [];
  private policyStats = { decisions: 0, denied: 0, confirmations: 0 };
  private outputs: Record<string, string | number | boolean | null> = {};
  private params: Params = {};
  private mutated = false;
  private irreversibleActs = 0;
  private handlerAttempts = new Map<string, number>();
  private readonly conditions: Condition[];
  private readonly capability: Capability;
  private readonly effectiveSteps: Array<{ step: Step; overridden: string[] }>;
  private readonly checkpoint: Expectation[];
  private readonly integrity: ReturnType<typeof checkIntegrity>;
  private readonly locatorKinds: TargetStrategyKind[];

  constructor(private readonly o: ReplayOptions) {
    this.runId = o.runId ?? ulid();
    this.capability = o.capability;
    this.integrity = checkIntegrity(o.capability);
    this.locatorKinds = o.locatorKinds ?? o.profile.locatorPolicy.allow;
    const override = o.capability.overrides[o.tenant.id];
    this.effectiveSteps = o.capability.steps.map((step) => {
      const ov = override?.steps[step.id];
      if (!ov) return { step, overridden: [] };
      const overridden: string[] = [];
      const merged: Step = { ...step } as Step;
      if (ov.target && "target" in merged) {
        (merged as { target: typeof ov.target }).target = ov.target;
        overridden.push("target");
      }
      if (ov.value && "value" in merged) {
        (merged as { value: typeof ov.value }).value = ov.value;
        overridden.push("value");
      }
      if (ov.expect) {
        merged.expect = ov.expect;
        overridden.push("expect");
      }
      if (ov.skip) overridden.push("skip");
      return { step: merged, overridden };
    });
    this.conditions = [
      ...(override?.conditions ?? []),
      ...o.capability.conditions,
      ...o.profile.conditions,
    ];
    this.checkpoint = override?.checkpoint ?? o.capability.checkpoint.expect;
    o.evidence.onEvent((e) => {
      if (e.type === "policy.decision") {
        this.policyStats.decisions++;
        const verdict = (e.data?.decision as Decision | undefined)?.verdict;
        if (verdict === "deny") this.policyStats.denied++;
        if (verdict === "confirm") this.policyStats.confirmations++;
      }
    });
  }

  async run(): Promise<RunResult> {
    const { evidence, capability } = this.o;
    // Mask sensitive inputs before the first event, which carries the raw inputs.
    for (const [name, value] of Object.entries(this.o.inputs)) {
      const sensitivity = capability.inputs[name]?.sensitivity;
      if (sensitivity === "pii" || sensitivity === "secret")
        this.o.redactor.registerSensitive(String(value), sensitivity);
    }
    evidence.emit(
      "run.start",
      `Replay ${capability.name}@${capability.version} on tenant ${this.o.tenant.id}`,
      {
        capability: {
          name: capability.name,
          version: capability.version,
          id: capability.id,
          status: capability.status,
        },
        tenant: this.o.tenant.id,
        inputs: this.o.inputs,
        approval: this.o.approval ?? null,
        requestedBy: this.o.requestedBy ?? null,
        idempotencyKey: this.o.idempotencyKey ?? null,
        locatorKinds: this.locatorKinds,
        assist: !!this.o.assist,
      },
    );
    evidence.emit(
      "integrity",
      `Artifact hash ${this.integrity.hash.slice(0, 12)}… effective status ${this.integrity.effectiveStatus}${this.integrity.problems.length ? ` (${this.integrity.problems.join("; ")})` : ""}`,
      { ...this.integrity },
    );
    if (this.o.approval) {
      this.o.audit?.record(
        "invocation.approval",
        this.o.approval.by,
        {
          capability: capability.name,
          version: capability.version,
          reason: this.o.approval.reason,
          requestedBy: this.o.requestedBy ?? null,
        },
        this.runId,
      );
    }
    if (capability.policy.riskClass === "irreversible" && !this.o.idempotencyKey) {
      evidence.emit(
        "ledger",
        "No idempotency key supplied for an irreversible capability; duplicate-invocation protection is unavailable for this run",
        { warning: true },
      );
    }
    try {
      this.params = this.validateInputs();
      await this.bootstrapSession();
      const result = await this.executeAll();
      return await this.finish(result);
    } catch (e) {
      if (e instanceof BusinessOutcomeSignal) {
        return await this.finish(
          this.base({
            status: "business_outcome",
            outcome: {
              code: e.code,
              message: e.message,
              conditionId: "ledger",
              ...(e.data ? { data: e.data } : {}),
            },
          }),
        );
      }
      return await this.finish(await this.toFailure(e));
    }
  }

  // ------------------------------------------------------------------ inputs

  private validateInputs(): Params {
    const params: Params = { ...this.o.tenant.params };
    const errors: string[] = [];
    for (const [name, spec] of Object.entries(this.capability.inputs)) {
      const raw = this.o.inputs[name];
      if (raw === undefined || raw === null || raw === "") {
        if (spec.default !== undefined) params[name] = spec.default;
        else if (spec.required) errors.push(`missing required input "${name}"`);
        continue;
      }
      const s = String(raw);
      if (spec.type === "integer" && !/^-?\d+$/.test(s))
        errors.push(`input "${name}" must be an integer`);
      if (spec.type === "number" && Number.isNaN(Number(s)))
        errors.push(`input "${name}" must be a number`);
      if (spec.type === "boolean" && !/^(true|false)$/i.test(s))
        errors.push(`input "${name}" must be true/false`);
      if (spec.pattern && !new RegExp(spec.pattern).test(s))
        errors.push(`input "${name}" does not match ${spec.pattern}`);
      if (spec.enum && !spec.enum.includes(s))
        errors.push(`input "${name}" must be one of ${spec.enum.join(", ")}`);
      params[name] = s;
      if (spec.sensitivity === "pii" || spec.sensitivity === "secret")
        this.o.redactor.registerSensitive(s, spec.sensitivity);
    }
    for (const name of Object.keys(this.o.inputs)) {
      if (!(name in this.capability.inputs)) errors.push(`unknown input "${name}"`);
    }
    if (errors.length) throw new RunFailure("INVALID_INPUT", errors.join("; "));
    return params;
  }

  // ------------------------------------------------------------------ session

  private policyCtx(): PolicyContext {
    return {
      mode: "replay",
      artifactStatus: this.integrity.effectiveStatus,
      invocationApproved: !!this.o.approval,
      requestedBy: this.o.requestedBy,
      approvedBy: this.o.approval?.by,
    };
  }

  private async bootstrapSession(): Promise<void> {
    if (!this.capability.entry.requiresSession) return;
    await ensureAuthenticated({
      surface: this.o.surface,
      profile: this.o.profile,
      tenant: this.o.tenant,
      params: this.params,
      secrets: this.o.secrets,
      policy: this.o.policy,
      policyCtx: this.policyCtx(),
      events: this.o.evidence,
    });
  }

  // ------------------------------------------------------------------ steps

  private async executeAll(): Promise<RunResult> {
    const { surface } = this.o;
    const entry = this.resolveEntry();
    if (entry && surface.currentUrl() !== entry) {
      await surface.navigate(entry);
      await surface.settle();
    }
    let i = 0;
    let restarts = 0;
    while (i < this.effectiveSteps.length) {
      const { step, overridden } = this.effectiveSteps[i]!;
      const frame: StepFrame = {
        step,
        index: i,
        report: {
          stepId: step.id,
          index: i,
          kind: step.kind,
          name: step.name,
          status: "ok",
          startedAt: new Date().toISOString(),
          durationMs: 0,
          attempts: 0,
          recoveries: [],
          ...(overridden.length ? { overridden } : {}),
        },
      };
      if (overridden.includes("skip")) {
        frame.report.status = "skipped";
        this.steps.push(frame.report);
        i++;
        continue;
      }
      let verdict: Verdict;
      try {
        verdict = await this.executeWithRecovery(frame);
      } finally {
        this.steps.push(frame.report);
      }
      switch (verdict.kind) {
        case "next":
        case "continue":
          i++;
          break;
        case "restart":
          if (++restarts > 3)
            throw new RunFailure(
              "UNKNOWN_STATE",
              "Too many restarts of the flow (re-authentication / transient errors)",
            );
          i = 0;
          break;
        case "terminal":
          return verdict.result;
        case "retry":
          break;
      }
    }
    return this.verifyCheckpoint();
  }

  private resolveEntry(): string | null {
    const e = this.capability.entry.url;
    if (e.kind === "template")
      return e.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n: string) => this.params[n] ?? "");
    if (e.kind === "literal") return e.value;
    if (e.kind === "param") return this.params[e.name] ?? null;
    return null;
  }

  /** Pre-act hook: irreversible cap + idempotency ledger. */
  private async beforeAct(step: Step): Promise<void> {
    if (step.risk !== "irreversible") return;
    const cap = this.o.policy.config.limits.maxIrreversiblePerRun;
    if (this.irreversibleActs >= cap) {
      throw new RunFailure(
        "POLICY_BLOCKED",
        `Irreversible action "${step.name}" exceeds the per-run cap of ${cap} (limits.maxIrreversiblePerRun)`,
      );
    }
    this.irreversibleActs++;
    const key = this.o.idempotencyKey;
    if (!key || !this.o.ledger) return;
    const prior = this.o.ledger.lookup(key, this.capability.name, step.id);
    if (prior?.status === "committed") {
      const outputs = this.o.ledger.committedOutputs(key, this.capability.name) ?? {};
      this.o.evidence.emit(
        "ledger",
        `Idempotency key ${key} already committed step ${step.id} in run ${prior.runId}; refusing to post again`,
        { key, prior },
      );
      this.ledgerTouched.push({ key, stepId: step.id, status: "duplicate" });
      this.o.audit?.record(
        "ledger.duplicate",
        this.o.requestedBy ?? "caller",
        { key, capability: this.capability.name, stepId: step.id, priorRun: prior.runId },
        this.runId,
      );
      throw new BusinessOutcomeSignal(
        "DUPLICATE_INVOCATION",
        `This invocation (idempotency key ${key}) already posted "${step.name}" in run ${prior.runId}; the earlier result is returned instead of posting twice`,
        { priorRunId: prior.runId, priorAt: prior.at, outputs },
      );
    }
    if (prior && (prior.status === "intent" || prior.status === "unknown")) {
      this.o.evidence.emit(
        "ledger",
        `Idempotency key ${key} has an unresolved ${prior.status} for step ${step.id} (run ${prior.runId}); a human must verify the system of record`,
        { key, prior },
      );
      this.ledgerTouched.push({ key, stepId: step.id, status: "unresolved" });
      throw new RunFailure(
        "UNKNOWN_STATE",
        `A previous invocation with idempotency key ${key} started "${step.name}" (run ${prior.runId}) and never recorded an outcome; verify in the system of record before posting again`,
      );
    }
    this.o.ledger.append({
      key,
      capability: this.capability.name,
      version: this.capability.version,
      tenant: this.o.tenant.id,
      stepId: step.id,
      runId: this.runId,
      status: "intent",
    });
    this.ledgerTouched.push({ key, stepId: step.id, status: "intent" });
    this.o.evidence.emit(
      "ledger",
      `Recorded intent for irreversible step ${step.id} under idempotency key ${key}`,
      { key, stepId: step.id },
    );
  }

  private ledgerOutcome(step: Step, status: "committed" | "unknown", note?: string): void {
    const key = this.o.idempotencyKey;
    if (step.risk !== "irreversible" || !key || !this.o.ledger) return;
    this.o.ledger.append({
      key,
      capability: this.capability.name,
      version: this.capability.version,
      tenant: this.o.tenant.id,
      stepId: step.id,
      runId: this.runId,
      status,
      outputs: { ...this.outputs },
      note,
    });
    this.ledgerTouched.push({ key, stepId: step.id, status });
    this.o.evidence.emit("ledger", `Ledger: step ${step.id} ${status}${note ? ` (${note})` : ""}`, {
      key,
      stepId: step.id,
      status,
    });
    this.o.audit?.record(
      `ledger.${status}`,
      "automation",
      { key, capability: this.capability.name, stepId: step.id },
      this.runId,
    );
  }

  private async executeWithRecovery(frame: StepFrame): Promise<Verdict> {
    const { step, report } = frame;
    const label = `${frame.index + 1}/${this.effectiveSteps.length}`;
    const started = Date.now();
    this.o.evidence.emit(
      "step.start",
      `[${label}] ${step.name} (${step.kind}, risk=${step.risk})`,
      { stepId: step.id, index: frame.index, kind: step.kind, risk: step.risk },
    );

    while (true) {
      report.attempts++;
      // A retry after a recovery or a human fix: if the step's post-conditions already hold,
      // the step is complete. Re-acting would be wrong (and, for a mutating step, a double post).
      if (report.attempts > 1 && step.expect.length > 0 && (await this.postConditionsHold(step))) {
        report.status = "recovered";
        report.screenshot = this.o.evidence.saveScreenshot(
          `${String(frame.index + 1).padStart(2, "0")}-${step.id}`,
          await this.o.surface.screenshot(),
        );
        report.durationMs = Date.now() - started;
        this.o.evidence.emit(
          "step.end",
          `[${label}] post-conditions already hold after recovery; step complete without re-acting`,
          { stepId: step.id, status: "recovered" },
        );
        if (step.risk !== "safe") this.mutated = true;
        return { kind: "next" };
      }
      // Pre-check: is the app in a known exceptional state before we act?
      const pre = await detectCondition(this.conditions, this.o.surface, this.params, step.id);
      if (pre) {
        const r = await this.handleCondition(pre, frame, "pre");
        if (r.kind === "retry") continue;
        if (r.kind !== "continue") {
          report.durationMs = Date.now() - started;
          return r;
        }
      }
      let acted = false;
      try {
        const outcome = await this.runStep(step, frame, label, (a) => (acted = a));
        this.absorbOutcome(step, frame, outcome);
        this.ledgerOutcome(step, "committed");
        report.screenshot = this.o.evidence.saveScreenshot(
          `${String(frame.index + 1).padStart(2, "0")}-${step.id}`,
          await this.o.surface.screenshot(),
        );
        report.durationMs = Date.now() - started;
        report.status = report.recoveries.length ? "recovered" : "ok";
        this.o.evidence.emit("step.end", `[${label}] ${report.status} in ${report.durationMs}ms`, {
          stepId: step.id,
          status: report.status,
        });
        return { kind: "next" };
      } catch (e) {
        if (!(e instanceof RunFailure)) throw e;
        if (acted) this.ledgerOutcome(step, "unknown", `${e.code}: ${truncate(e.message, 80)}`);
        // Post-failure diagnosis: a known condition explains the failure?
        const post = await detectCondition(this.conditions, this.o.surface, this.params, step.id);
        if (post) {
          const r = await this.handleCondition(post, frame, "post", e);
          if (r.kind === "retry") continue;
          if (r.kind !== "continue") report.durationMs = Date.now() - started;
          return r;
        }
        if (e.code === "POLICY_BLOCKED") {
          await this.captureFailureEvidence(frame, e);
          throw this.attachStep(e, frame);
        }
        // Lost control: one bounded, policy-checked model assist before involving a human.
        if (!acted && (e.code === "TARGET_NOT_FOUND" || e.code === "TARGET_AMBIGUOUS")) {
          const assisted = await this.tryAssist(frame, e, label);
          if (assisted) {
            report.durationMs = Date.now() - started;
            return assisted;
          }
        }
        // Unknown state: escalate (if allowed) or fail.
        const r = await this.escalateFailure(frame, e);
        if (r.kind === "retry") continue;
        report.durationMs = Date.now() - started;
        return r;
      }
    }
  }

  private async postConditionsHold(step: Step): Promise<boolean> {
    for (const e of step.expect) {
      const r = await this.o.surface.check(e, this.params, { timeoutMs: 1500 });
      if (!r.ok) return false;
    }
    return true;
  }

  private runStep(step: Step, frame: StepFrame, label: string, onActed: (acted: boolean) => void) {
    return executeStep(step, {
      surface: this.o.surface,
      policy: this.o.policy,
      policyCtx: this.policyCtx(),
      params: this.params,
      secrets: this.o.secrets,
      events: this.o.evidence,
      defaultTimeoutMs: this.o.profile.defaultStepTimeoutMs,
      confirm: (s, d) => this.confirmRisky(s, d, frame),
      beforeAct: async (s) => {
        await this.beforeAct(s);
        onActed(true);
      },
      locatorKinds: this.locatorKinds,
      preferKinds: this.o.locatorKinds,
      label,
    });
  }

  private absorbOutcome(
    step: Step,
    frame: StepFrame,
    outcome: Awaited<ReturnType<typeof executeStep>>,
  ): void {
    const { report } = frame;
    if (outcome.resolution) {
      report.resolution = outcome.resolution;
      const tier = String(outcome.resolution.tier);
      this.tierHistogram[tier] = (this.tierHistogram[tier] ?? 0) + 1;
      if (outcome.resolution.tier > 0 && "target" in step) {
        const primary = step.target.strategies[0]?.kind;
        const w = `step ${step.id}: primary strategy "${primary}" did not resolve; fell back to "${outcome.resolution.strategy}" (tier ${outcome.resolution.tier})`;
        this.driftWarnings.push(w);
        this.o.evidence.emit("drift.warning", w, {
          stepId: step.id,
          resolution: outcome.resolution,
        });
        if (outcome.resolvedElement)
          this.proposeOverride(frame, outcome.resolvedElement, outcome.resolution.strategy);
      }
    }
    if (outcome.dialogs.length) {
      const d = outcome.dialogs[0]!;
      report.dialog = { message: d.message, type: d.type, response: d.response };
    }
    if (outcome.extracted) {
      report.extracted = { output: outcome.extracted.output, raw: outcome.extracted.raw };
      this.outputs[outcome.extracted.output] = outcome.extracted.value;
    }
    if (step.risk !== "safe") this.mutated = true;
  }

  private proposeOverride(
    frame: StepFrame,
    element: NonNullable<Awaited<ReturnType<typeof executeStep>>["resolvedElement"]>,
    via: string,
  ): void {
    void (async () => {
      try {
        const target = this.o.surface.describeTarget(
          element,
          this.params,
          await this.o.surface.screenshot(),
        );
        frame.report.proposedOverride = { target, resolvedVia: via };
      } catch {
        /* proposal is best-effort */
      }
    })();
  }

  // ------------------------------------------------------------------ assisted recovery

  private async tryAssist(
    frame: StepFrame,
    err: RunFailure,
    label: string,
  ): Promise<Verdict | null> {
    const a = this.o.assist;
    if (!a || !this.o.policy.config.assist.enabled || !("target" in frame.step)) return null;
    if (this.assists.length >= Math.min(a.maxPerRun, this.o.policy.config.assist.maxPerRun))
      return null;
    const { step } = frame;
    const obs = await this.o.surface.observe({ marks: true });
    const shot = this.o.evidence.saveScreenshot(`assist-${step.id}`, obs.screenshot, "assists");
    this.o.evidence.emit(
      "assist.requested",
      `[${label}] asking the model which visible element matches "${step.name}" (${err.code})`,
      { stepId: step.id, screenshot: shot },
    );
    const record: AssistRecord = {
      stepId: step.id,
      reason: `${err.code}: ${err.message}`,
      proposed: null,
      decision: "no_candidate",
    };
    this.assists.push(record);
    let proposal: { ref: string | null; reason: string };
    try {
      proposal = await a.decider.assist({
        observation: obs,
        step: {
          id: step.id,
          kind: step.kind,
          name: step.name,
          intent: step.intent,
          targetDescription: step.target.description,
        },
        failure: { code: err.code, message: err.message },
        goal: this.capability.goal,
      });
    } catch (e) {
      record.note = `assist call failed: ${errorMessage(e)}`;
      this.o.evidence.emit("error", record.note, { stepId: step.id });
      return null;
    }
    const el = proposal.ref ? obs.elements.find((x) => x.ref === proposal.ref) : undefined;
    if (!el) {
      record.note = proposal.reason;
      this.o.evidence.emit("assist.applied", `[${label}] no candidate: ${proposal.reason}`, {
        stepId: step.id,
        decision: "no_candidate",
      });
      return null;
    }
    record.proposed = { ref: el.ref, role: el.role, name: el.name, text: el.text, frame: el.frame };
    record.note = proposal.reason;
    // The assisted element runs through the very same gate as a recorded one.
    const target: Target = this.o.surface.describeTarget(el, this.params, obs.screenshotPlain);
    const trial: Step = { ...step, target } as Step;
    const proposed = toProposedAction(
      trial,
      { surface: this.o.surface, params: this.params, secrets: this.o.secrets } as never,
      undefined,
    );
    const decision = proposed
      ? this.o.policy.evaluate(
          {
            ...proposed,
            controlName: el.name || el.labelText || el.text || undefined,
            controlRole: el.role,
            formSubmitLabels: el.formSubmitLabels,
          },
          this.policyCtx(),
        )
      : null;
    if (decision && decision.verdict === "deny") {
      record.decision = "policy_denied";
      this.o.evidence.emit(
        "assist.applied",
        `[${label}] proposal ${el.ref} "${el.name || el.text}" denied by policy: ${decision.reason}`,
        { stepId: step.id, decision: "policy_denied" },
      );
      return null;
    }
    if (decision && decision.verdict === "confirm" && !this.o.broker) {
      record.decision = "declined";
      record.note = `${decision.reason}; no operator to confirm`;
      return null;
    }
    try {
      const outcome = await this.runStep(trial, frame, `${label} assisted`, () => {});
      this.absorbOutcome(trial, frame, outcome);
      record.decision = "applied";
      record.target = target;
      frame.report.proposedOverride = { target, resolvedVia: "assist" };
      frame.report.status = "recovered";
      frame.report.screenshot = this.o.evidence.saveScreenshot(
        `${String(frame.index + 1).padStart(2, "0")}-${step.id}`,
        await this.o.surface.screenshot(),
      );
      this.ledgerOutcome(step, "committed");
      this.o.evidence.emit(
        "assist.applied",
        `[${label}] applied: ${el.role} "${el.name || el.text}" (${proposal.reason})`,
        { stepId: step.id, decision: "applied", element: record.proposed },
      );
      return { kind: "next" };
    } catch (e) {
      record.decision = "declined";
      record.note = `assisted attempt failed: ${errorMessage(e)}`;
      this.o.evidence.emit(
        "assist.applied",
        `[${label}] assisted attempt failed: ${errorMessage(e)}`,
        { stepId: step.id, decision: "declined" },
      );
      return null;
    }
  }

  // ------------------------------------------------------------------ conditions

  private async handleCondition(
    d: Detected,
    frame: StepFrame,
    phase: "pre" | "post",
    cause?: RunFailure,
  ): Promise<Verdict> {
    const c = d.condition;
    const { evidence } = this.o;
    const hit: ConditionHit = {
      conditionId: c.id,
      class: c.class,
      description: c.description,
      handled: "terminal",
      stepId: frame.step.id,
    };
    evidence.emit(
      "condition.detected",
      `Condition "${c.id}" (${c.class}) detected ${phase}-step ${frame.step.id}: ${c.description}`,
      {
        conditionId: c.id,
        class: c.class,
        phase,
        observed: d.observed,
        stepId: frame.step.id,
      },
    );
    const shot = evidence.saveScreenshot(
      `cond-${c.id}-${frame.step.id}`,
      await this.o.surface.screenshot(),
      "conditions",
    );

    if (c.class === "business_outcome") {
      const data: Record<string, unknown> = {};
      for (const ex of c.outcome?.extract ?? []) {
        try {
          const r = await this.o.surface.resolve(ex.target, this.params, { timeoutMs: 2000 });
          data[ex.name] = parseValue(await this.o.surface.readText(r), ex.parse);
        } catch (e) {
          data[ex.name] = null;
          evidence.emit("error", `outcome extract ${ex.name} failed: ${errorMessage(e)}`);
        }
      }
      frame.report.recoveries.push(hit);
      frame.report.status = "failed";
      frame.report.screenshot = shot;
      this.recoveries.push(hit);
      evidence.emit(
        "condition.handled",
        `Business outcome ${c.outcome?.code}: ${c.outcome?.message}`,
        { conditionId: c.id, code: c.outcome?.code, data },
      );
      return {
        kind: "terminal",
        result: this.base({
          status: "business_outcome",
          outcome: {
            code: c.outcome?.code ?? c.id.toUpperCase(),
            message: c.outcome?.message ?? c.description,
            conditionId: c.id,
            ...(Object.keys(data).length ? { data } : {}),
          },
        }),
      };
    }

    if (c.class === "hard_failure") {
      frame.report.recoveries.push(hit);
      this.recoveries.push(hit);
      const err = new RunFailure(
        (c.failureCode as RunError["code"]) ?? "UNKNOWN_STATE",
        c.description,
        { expected: cause?.detail.expected ?? `no "${c.id}" condition`, observed: d.observed },
      );
      return this.escalateFailure(frame, err, c);
    }

    // recoverable
    const handler = c.handler ?? { kind: "escalate" as const };
    const attempts = (this.handlerAttempts.get(c.id) ?? 0) + 1;
    this.handlerAttempts.set(c.id, attempts);
    hit.handler = handler.kind;
    hit.attempt = attempts;
    if (this.mutated && !c.safeAfterMutation) {
      hit.handled = "escalated";
      frame.report.recoveries.push(hit);
      this.recoveries.push(hit);
      evidence.emit(
        "condition.handled",
        `Condition "${c.id}" is recoverable but a mutating step already ran; escalating instead of re-running`,
        { conditionId: c.id },
      );
      return this.escalateFailure(
        frame,
        new RunFailure(
          "UNKNOWN_STATE",
          `${c.description} after a mutating step; automatic recovery (${handler.kind}) is not safe`,
          { observed: d.observed },
        ),
        c,
      );
    }
    const maxAttempts = handler.kind === "wait_retry" ? handler.maxAttempts : 3;
    if (attempts > maxAttempts) {
      hit.handled = "failed";
      frame.report.recoveries.push(hit);
      this.recoveries.push(hit);
      return this.escalateFailure(
        frame,
        new RunFailure(
          (c.failureCode as RunError["code"]) ?? "UNKNOWN_STATE",
          `${c.description} persisted after ${attempts - 1} recovery attempts`,
          { observed: d.observed },
        ),
        c,
      );
    }
    const restart = async (): Promise<Verdict> => {
      const entry = this.resolveEntry();
      if (entry) {
        await this.o.surface.navigate(entry);
        await this.o.surface.settle();
      }
      return { kind: "restart" };
    };
    switch (handler.kind) {
      case "dismiss": {
        const r = await this.o.surface.resolve(handler.target, this.params, { timeoutMs: 5000 });
        await this.o.surface.click(r);
        await this.o.surface.settle();
        hit.handled = "resolved";
        frame.report.recoveries.push(hit);
        this.recoveries.push(hit);
        evidence.emit(
          "condition.handled",
          `Dismissed "${c.id}" via ${handler.target.description}; ${handler.then}`,
          { conditionId: c.id, attempt: attempts },
        );
        return handler.then === "retry_step" ? { kind: "retry" } : { kind: "continue" };
      }
      case "wait_retry":
        evidence.emit(
          "condition.handled",
          `Waiting ${handler.waitMs}ms then ${handler.then === "restart" ? "restarting the flow" : "retrying the step"} (attempt ${attempts}/${handler.maxAttempts}) for "${c.id}"`,
          { conditionId: c.id, attempt: attempts },
        );
        await new Promise((r) => setTimeout(r, handler.waitMs));
        hit.handled = "resolved";
        frame.report.recoveries.push(hit);
        this.recoveries.push(hit);
        return handler.then === "restart" ? restart() : { kind: "retry" };
      case "reauthenticate":
        evidence.emit("condition.handled", `Re-authenticating for "${c.id}" then ${handler.then}`, {
          conditionId: c.id,
          attempt: attempts,
        });
        await this.bootstrapSession();
        hit.handled = "resolved";
        frame.report.recoveries.push(hit);
        this.recoveries.push(hit);
        return handler.then === "restart" ? restart() : { kind: "retry" };
      case "escalate":
        hit.handled = "escalated";
        frame.report.recoveries.push(hit);
        this.recoveries.push(hit);
        return this.escalateFailure(
          frame,
          new RunFailure("UNKNOWN_STATE", handler.reason ?? c.description, {
            observed: d.observed,
          }),
          c,
        );
    }
  }

  // ------------------------------------------------------------------ escalation

  private async confirmRisky(
    step: Step,
    decision: Extract<Decision, { verdict: "confirm" }>,
    frame: StepFrame,
  ): Promise<boolean> {
    if (!this.o.broker)
      throw new RunFailure(
        "POLICY_BLOCKED",
        `${decision.reason}; no operator console is attached to approve it`,
      );
    const obs = await this.o.surface.observe();
    const shot = this.o.evidence.saveScreenshot(
      `approval-${step.id}`,
      obs.screenshotPlain,
      "interventions",
    );
    const res = await this.raise({
      type: "approval",
      reason: { code: "APPROVAL_REQUIRED", message: `${decision.reason} (${decision.rule})` },
      allowed: ["approve", "deny", "abort"],
      frame,
      obs,
      shot,
    });
    if (res === "abort")
      throw new RunFailure("HUMAN_ABORTED", `Operator aborted the run at "${step.name}"`);
    return res === "approve";
  }

  private async escalateFailure(
    frame: StepFrame,
    err: RunFailure,
    condition?: Condition,
  ): Promise<Verdict> {
    const { evidence } = this.o;
    const stepOnFailure = frame.step.onFailure ?? "escalate";
    if (stepOnFailure === "skip") {
      frame.report.status = "skipped";
      evidence.emit(
        "step.end",
        `Step ${frame.step.id} skipped on failure per artifact (${err.code})`,
        { stepId: frame.step.id },
      );
      return { kind: "continue" };
    }
    const canEscalate =
      !!this.o.broker && this.o.policy.config.escalation.onHardFailure && stepOnFailure !== "fail";
    await this.captureFailureEvidence(frame, err);
    if (!canEscalate) throw this.attachStep(err, frame);

    const obs = await this.o.surface.observe();
    const shot = evidence.saveScreenshot(
      `stuck-${frame.step.id}`,
      obs.screenshotPlain,
      "interventions",
    );
    const res = await this.raise({
      type: "failure",
      reason: {
        code: err.code,
        message: err.message,
        expected: err.detail.expected,
        observed: err.detail.observed,
      },
      allowed: ["retry", "skip", "resume", "abort"],
      frame,
      obs,
      shot,
      condition,
    });
    switch (res) {
      case "retry":
        frame.report.status = "recovered";
        return { kind: "retry" };
      case "skip":
      case "resume":
        frame.report.status = "recovered";
        return { kind: "continue" };
      default:
        throw this.attachStep(
          new RunFailure(
            "HUMAN_ABORTED",
            `Operator aborted the run at "${frame.step.name}" (${err.code}: ${err.message})`,
            err.detail,
          ),
          frame,
        );
    }
  }

  private async raise(a: {
    type: InterventionRequest["type"];
    reason: InterventionRequest["reason"];
    allowed: ResolutionKind[];
    frame: StepFrame;
    obs: Observation;
    shot: string;
    condition?: Condition;
  }): Promise<ResolutionKind> {
    const broker = this.o.broker!;
    const summary: InterventionSummary = {
      id: "",
      type: a.type,
      reason: a.reason.message,
      raisedAt: new Date().toISOString(),
      humanActions: 0,
      controlTransfers: 0,
    };
    this.interventions.push(summary);
    const onRaised = (req: InterventionRequest) => {
      summary.id = req.id;
    };
    broker.once("raised", onRaised);
    try {
      const res = await broker.raise(
        {
          runId: this.runId,
          runKind: "replay",
          type: a.type,
          capability: { name: this.capability.name, version: this.capability.version },
          goal: this.capability.goal,
          tenant: this.o.tenant.id,
          step: {
            id: a.frame.step.id,
            index: a.frame.index,
            name: a.frame.step.name,
            kind: a.frame.step.kind,
          },
          reason: a.condition
            ? { ...a.reason, message: `${a.reason.message} [condition: ${a.condition.id}]` }
            : a.reason,
          url: a.obs.url,
          landmark: a.obs.landmark,
          screenshot: a.shot,
          elements: a.obs.elements
            .filter((e) => e.role !== "text")
            .map((e) => ({
              ref: e.ref,
              role: e.role,
              name: e.name,
              text: e.text,
              bbox: e.bbox,
              frame: e.frame,
            })),
          allowedResolutions: a.allowed,
          timeoutMs: this.o.policy.config.escalation.timeoutMs,
          screenshotPng: a.obs.screenshotPlain,
        },
        this.o.evidence,
      );
      const req = broker.get(summary.id);
      summary.resolvedAt = res.at;
      summary.resolution = res.kind;
      summary.operator = res.operator;
      summary.note = res.note;
      summary.humanActions = req?.humanActions.length ?? 0;
      summary.controlTransfers = req?.controlTransfers ?? 0;
      if (req) {
        this.o.evidence.saveJson(`interventions/${req.id}.json`, req);
        if (a.type === "failure" && (res.kind === "retry" || res.kind === "resume"))
          this.learnFromHuman(req, a.obs);
      }
      await this.o.surface.settle();
      return res.kind;
    } catch (e) {
      broker.off("raised", onRaised);
      if (e instanceof InterventionTimeout) {
        summary.resolvedAt = new Date().toISOString();
        summary.resolution = "abort";
        summary.note = "timed out";
        throw new RunFailure(
          "ESCALATION_TIMEOUT",
          `No operator responded within ${this.o.policy.config.escalation.timeoutMs}ms at "${a.frame.step.name}"`,
          { expected: a.reason.expected, observed: a.reason.observed },
        );
      }
      throw e;
    }
  }

  /**
   * What the human did to get past an unknown screen is, in shape, a recoverable condition:
   * detector = the screen's heading, handler = the control they clicked. Proposed, never
   * applied automatically; `cua promote --conditions` adds it to the artifact for review.
   */
  private learnFromHuman(req: InterventionRequest, obs: Observation): void {
    const click = req.humanActions.find((h) => h.kind === "click" && h.target);
    if (!click?.target || !obs.landmark) return;
    const landmark = parameterize(obs.landmark, this.params);
    const id = `human_${landmark
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 32)}`;
    if (
      this.proposedConditions.some((c) => c.id === id) ||
      this.conditions.some((c) => c.id === id)
    )
      return;
    const condition: Condition = {
      id,
      description: `Screen "${landmark}" cleared by operator ${req.control.operator ?? req.resolution?.operator ?? "operator"} via ${click.target.description} (run ${this.runId})`,
      detect: { kind: "text", text: landmark, frame: this.o.profile.contentFrame },
      class: "recoverable",
      handler: { kind: "dismiss", target: click.target, then: "retry_step" },
      safeAfterMutation: false,
      origin: "human",
    };
    this.proposedConditions.push(condition);
    this.o.evidence.emit(
      "condition.proposed",
      `Proposed condition "${id}" from the operator's actions (review with cua promote --conditions)`,
      {
        condition: { ...condition, handler: { kind: "dismiss", target: click.target.description } },
      },
    );
  }

  // ------------------------------------------------------------------ checkpoint & result

  private async verifyCheckpoint(): Promise<RunResult> {
    const { surface, evidence } = this.o;
    for (const e of this.checkpoint) {
      const r = await surface.check(e, this.params, {
        timeoutMs: this.o.profile.defaultStepTimeoutMs,
      });
      evidence.emit(
        "step.expect",
        `[checkpoint] ${describeExpectation(e)} → ${r.ok ? "ok" : "FAILED"} (${truncate(r.observed, 120)})`,
        { ok: r.ok, observed: r.observed },
      );
      if (!r.ok) {
        const post = await detectCondition(this.conditions, surface, this.params);
        if (post && post.condition.class === "business_outcome") {
          return this.base({
            status: "business_outcome",
            outcome: {
              code: post.condition.outcome?.code ?? post.condition.id.toUpperCase(),
              message: post.condition.outcome?.message ?? post.condition.description,
              conditionId: post.condition.id,
            },
          });
        }
        throw new RunFailure(
          "CHECKPOINT_FAILED",
          `Checkpoint not met: ${this.capability.checkpoint.description}`,
          { expected: describeExpectation(e), observed: r.observed },
        );
      }
    }
    const missing = Object.keys(this.capability.outputs).filter((k) => !(k in this.outputs));
    if (missing.length)
      throw new RunFailure(
        "OUTPUT_PARSE_ERROR",
        `Declared outputs were not extracted: ${missing.join(", ")}`,
      );
    for (const [name, spec] of Object.entries(this.capability.outputs)) {
      const v = this.outputs[name];
      if (typeof v === "string" && (spec.sensitivity === "pii" || spec.sensitivity === "secret"))
        this.o.redactor.registerSensitive(v, spec.sensitivity);
    }
    return this.base({ status: "success", outputs: this.outputs });
  }

  private async captureFailureEvidence(frame: StepFrame, err: RunFailure): Promise<void> {
    const { evidence, surface } = this.o;
    try {
      const shot = evidence.saveScreenshot(
        `fail-${frame.step.id}`,
        await surface.screenshot(),
        "failure",
      );
      const dom = evidence.saveText(
        `failure/dom-${frame.step.id}.html`,
        await surface.domSnapshot(),
      );
      frame.report.error = this.toRunError(err, frame, [shot, dom]);
      frame.report.screenshot = shot;
      evidence.emit("evidence.captured", `Failure evidence for ${frame.step.id}: ${shot}, ${dom}`, {
        stepId: frame.step.id,
        files: [shot, dom],
      });
    } catch (e) {
      evidence.emit("error", `could not capture failure evidence: ${errorMessage(e)}`);
    }
  }

  private attachStep(err: RunFailure, frame: StepFrame): RunFailure {
    frame.report.status = "failed";
    frame.report.error = this.toRunError(err, frame, frame.report.error?.evidence ?? []);
    return err;
  }

  private toRunError(err: RunFailure, frame: StepFrame | null, evidenceFiles: string[]): RunError {
    return {
      code: err.code,
      message: err.message,
      ...(frame
        ? { stepId: frame.step.id, stepIndex: frame.index, stepName: frame.step.name }
        : {}),
      expected: err.detail.expected,
      observed: err.detail.observed,
      evidence: evidenceFiles,
      cause: err.detail.cause ? errorMessage(err.detail.cause) : undefined,
    };
  }

  private async toFailure(e: unknown): Promise<RunResult> {
    const err =
      e instanceof RunFailure ? e : new RunFailure("SURFACE_ERROR", errorMessage(e), { cause: e });
    const failed = this.steps.find((s) => s.error);
    const files = failed?.error?.evidence ?? [];
    if (files.length === 0) {
      try {
        files.push(
          this.o.evidence.saveScreenshot(
            "fail-final",
            await this.o.surface.screenshot(),
            "failure",
          ),
        );
        files.push(
          this.o.evidence.saveText("failure/dom-final.html", await this.o.surface.domSnapshot()),
        );
      } catch {
        /* surface may be gone */
      }
    }
    const runErr: RunError = failed?.error
      ? { ...failed.error, code: err.code, message: err.message, evidence: files }
      : { ...this.toRunError(err, null, files) };
    return this.base({ status: "failure", error: runErr });
  }

  private base<T extends { status: RunResult["status"] }>(extra: T): RunResult {
    const endedAt = new Date();
    const drift: DriftReport = { tierHistogram: this.tierHistogram, warnings: this.driftWarnings };
    const maskedInputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.o.inputs)) {
      const spec = this.capability.inputs[k];
      maskedInputs[k] =
        spec && spec.sensitivity !== "none" ? this.o.redactor.redactString(String(v)) : v;
    }
    return {
      runId: this.runId,
      kind: "replay",
      capability: {
        name: this.capability.name,
        version: this.capability.version,
        id: this.capability.id,
      },
      tenant: this.o.tenant.id,
      inputs: maskedInputs,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - this.startedAt.getTime(),
      steps: this.steps,
      recoveries: this.recoveries,
      interventions: this.interventions,
      assists: this.assists,
      proposedConditions: this.proposedConditions,
      drift,
      evidence: { dir: this.o.evidence.dir, events: "events.jsonl" },
      policy: this.policyStats,
      integrity: {
        hash: this.integrity.hash,
        approvedHashMatches: this.integrity.approvedHashMatches,
        effectiveStatus: this.integrity.effectiveStatus,
      },
      ...(this.ledgerTouched.length ? { ledger: this.ledgerTouched } : {}),
      ...extra,
    } as unknown as RunResult;
  }

  private async finish(result: RunResult): Promise<RunResult> {
    const { evidence } = this.o;
    if (result.status === "success" && this.o.idempotencyKey && this.o.ledger) {
      const committed = this.ledgerTouched.filter((l) => l.status === "committed");
      for (const l of committed) {
        const step = this.capability.steps.find((s) => s.id === l.stepId);
        if (step) this.ledgerOutcome(step, "committed", "final outputs");
      }
    }
    const surface = this.o.surface as Partial<PlaywrightSurface>;
    if (result.status !== "success" && typeof surface.stopTrace === "function") {
      const tracePath = evidence.filePath("failure/trace.zip");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      if (await surface.stopTrace(tracePath)) result.evidence.trace = "failure/trace.zip";
    }
    if (result.status === "failure")
      result.evidence.failureScreenshot = result.error.evidence.find((f) => f.endsWith(".png"));
    evidence.saveJson("result.json", result);
    evidence.emit(
      "run.end",
      `Replay ended: ${result.status}${result.status === "business_outcome" ? ` (${result.outcome.code})` : result.status === "failure" ? ` (${result.error.code} at ${result.error.stepId ?? "?"})` : ""} in ${result.durationMs}ms`,
      {
        status: result.status,
        ...(result.status === "success" ? { outputs: result.outputs } : {}),
        ...(result.status === "business_outcome" ? { outcome: result.outcome } : {}),
        ...(result.status === "failure" ? { error: result.error } : {}),
        drift: result.drift,
        interventions: result.interventions,
        assists: result.assists,
        proposedConditions: result.proposedConditions.map((c) => c.id),
      },
    );
    return result;
  }
}

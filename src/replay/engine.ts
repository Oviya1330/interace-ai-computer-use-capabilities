/**
 * Deterministic replay engine — the production execution path.
 *
 * Given a capability artifact + inputs, it:
 *   1. validates inputs against the artifact contract,
 *   2. bootstraps an authenticated session from the app profile,
 *   3. executes steps with stable multi-strategy targeting and post-condition checks,
 *   4. detects runtime conditions (business outcome / recoverable / hard failure) before every
 *      step and whenever a step fails, and responds deliberately,
 *   5. verifies the checkpoint and returns declared outputs,
 *   6. escalates to a human (live-session handoff) when it cannot safely proceed.
 * No LLM is involved anywhere in this file.
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
} from "../core/schema.js";
import type { Params, SecretResolver } from "../core/template.js";
import { RunFailure, errorMessage } from "../core/errors.js";
import type {
  ConditionHit,
  DriftReport,
  InterventionSummary,
  RunError,
  RunResult,
  StepReport,
} from "../core/result.js";
import type { Surface } from "../surface/types.js";
import type { PlaywrightSurface } from "../surface/playwright.js";
import type { PolicyGate, Decision } from "../policy/policy.js";
import type { RunEvidence } from "../evidence/store.js";
import type { Redactor } from "../policy/redact.js";
import {
  InterventionBroker,
  InterventionTimeout,
  type InterventionRequest,
  type ResolutionKind,
} from "../hitl/broker.js";
import { executeStep, describeExpectation } from "./steps.js";
import { detectCondition, type Detected } from "./conditions.js";
import { ensureAuthenticated } from "./session.js";
import { parseValue } from "./parse.js";
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
  runId?: string;
  maxRunMs?: number;
}

interface StepFrame {
  step: Step;
  index: number;
  report: StepReport;
}

export class ReplayEngine {
  private readonly runId: string;
  private readonly startedAt = new Date();
  private readonly steps: StepReport[] = [];
  private readonly recoveries: ConditionHit[] = [];
  private readonly interventions: InterventionSummary[] = [];
  private readonly tierHistogram: Record<string, number> = {};
  private readonly driftWarnings: string[] = [];
  private policyStats = { decisions: 0, denied: 0, confirmations: 0 };
  private outputs: Record<string, string | number | boolean | null> = {};
  private params: Params = {};
  private mutated = false;
  private handlerAttempts = new Map<string, number>();
  private readonly conditions: Condition[];
  private readonly capability: Capability;
  private readonly effectiveSteps: Array<{ step: Step; overridden: string[] }>;
  private readonly checkpoint: Expectation[];

  constructor(private readonly o: ReplayOptions) {
    this.runId = o.runId ?? ulid();
    this.capability = o.capability;
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
      },
    );
    try {
      this.params = this.validateInputs();
      await this.bootstrapSession();
      const result = await this.executeAll();
      return await this.finish(result);
    } catch (e) {
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

  private policyCtx() {
    return {
      mode: "replay" as const,
      artifactStatus: this.capability.status,
      invocationApproved: !!this.o.approval,
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
      let verdict: Awaited<ReturnType<ReplayEngine["executeWithRecovery"]>>;
      try {
        verdict = await this.executeWithRecovery(frame);
      } finally {
        this.steps.push(frame.report);
      }
      switch (verdict.kind) {
        case "next":
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
      }
    }
    return this.verifyCheckpoint();
  }

  private resolveEntry(): string | null {
    const e = this.capability.entry.url;
    try {
      if (e.kind === "template")
        return e.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n: string) => this.params[n] ?? "");
      if (e.kind === "literal") return e.value;
      if (e.kind === "param") return this.params[e.name] ?? null;
    } catch {
      return null;
    }
    return null;
  }

  private async executeWithRecovery(
    frame: StepFrame,
  ): Promise<{ kind: "next" } | { kind: "restart" } | { kind: "terminal"; result: RunResult }> {
    const { step, report } = frame;
    const label = `${frame.index + 1}/${this.effectiveSteps.length}`;
    const started = Date.now();
    this.o.evidence.emit(
      "step.start",
      `[${label}] ${step.name} (${step.kind}, risk=${step.risk})`,
      {
        stepId: step.id,
        index: frame.index,
        kind: step.kind,
        risk: step.risk,
      },
    );

    while (true) {
      report.attempts++;
      // Pre-check: is the app in a known exceptional state before we act?
      const pre = await detectCondition(this.conditions, this.o.surface, this.params, step.id);
      if (pre) {
        const r = await this.handleCondition(pre, frame, "pre");
        if (r.kind === "retry") continue;
        if (r.kind === "continue") {
          /* handled, proceed with the step */
        } else {
          report.durationMs = Date.now() - started;
          return r;
        }
      }
      try {
        const outcome = await executeStep(step, {
          surface: this.o.surface,
          policy: this.o.policy,
          policyCtx: this.policyCtx(),
          params: this.params,
          secrets: this.o.secrets,
          events: this.o.evidence,
          defaultTimeoutMs: this.o.profile.defaultStepTimeoutMs,
          confirm: (s, d) => this.confirmRisky(s, d, frame),
          label,
        });
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
            if (outcome.resolvedElement) {
              try {
                const target = this.o.surface.describeTarget(
                  outcome.resolvedElement,
                  this.params,
                  await this.o.surface.screenshot(),
                );
                report.proposedOverride = { target, resolvedVia: outcome.resolution.strategy };
              } catch {
                /* proposal is best-effort */
              }
            }
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
        // Post-failure diagnosis: a known condition explains the failure?
        const post = await detectCondition(this.conditions, this.o.surface, this.params, step.id);
        if (post) {
          const r = await this.handleCondition(post, frame, "post", e);
          if (r.kind === "retry") continue;
          if (r.kind === "continue") return { kind: "next" };
          report.durationMs = Date.now() - started;
          return r;
        }
        if (e.code === "POLICY_BLOCKED") {
          await this.captureFailureEvidence(frame, e);
          throw this.attachStep(e, frame);
        }
        // Unknown state: escalate (if allowed) or fail.
        const r = await this.escalateFailure(frame, e);
        if (r.kind === "retry") continue;
        if (r.kind === "continue") return { kind: "next" };
        report.durationMs = Date.now() - started;
        return r;
      }
    }
  }

  // ------------------------------------------------------------------ conditions

  private async handleCondition(
    d: Detected,
    frame: StepFrame,
    phase: "pre" | "post",
    cause?: RunFailure,
  ): Promise<
    | { kind: "retry" }
    | { kind: "continue" }
    | { kind: "restart" }
    | { kind: "terminal"; result: RunResult }
  > {
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
      hit.handled = "terminal";
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
      hit.handled = "terminal";
      frame.report.recoveries.push(hit);
      this.recoveries.push(hit);
      const err = new RunFailure(
        (c.failureCode as RunError["code"]) ?? "UNKNOWN_STATE",
        `${c.description}`,
        {
          expected: cause?.detail.expected ?? `no "${c.id}" condition`,
          observed: d.observed,
        },
      );
      return this.escalateFailure(frame, err, c);
    }

    // recoverable
    const handler = c.handler ?? { kind: "escalate" as const };
    const attempts = (this.handlerAttempts.get(c.id) ?? 0) + 1;
    this.handlerAttempts.set(c.id, attempts);
    hit.handler = handler.kind;
    hit.attempt = attempts;
    const unsafe = this.mutated && !c.safeAfterMutation;
    if (unsafe) {
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
      const err = new RunFailure(
        (c.failureCode as RunError["code"]) ?? "UNKNOWN_STATE",
        `${c.description} persisted after ${attempts - 1} recovery attempts`,
        { observed: d.observed },
      );
      return this.escalateFailure(frame, err, c);
    }
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
      case "wait_retry": {
        evidence.emit(
          "condition.handled",
          `Waiting ${handler.waitMs}ms then ${handler.then === "restart" ? "restarting the flow" : "retrying the step"} (attempt ${attempts}/${handler.maxAttempts}) for "${c.id}"`,
          { conditionId: c.id, attempt: attempts },
        );
        await new Promise((r) => setTimeout(r, handler.waitMs));
        hit.handled = "resolved";
        frame.report.recoveries.push(hit);
        this.recoveries.push(hit);
        if (handler.then === "restart") {
          const entry = this.resolveEntry();
          if (entry) {
            await this.o.surface.navigate(entry);
            await this.o.surface.settle();
          }
          return { kind: "restart" };
        }
        return { kind: "retry" };
      }
      case "reauthenticate": {
        evidence.emit("condition.handled", `Re-authenticating for "${c.id}" then ${handler.then}`, {
          conditionId: c.id,
          attempt: attempts,
        });
        await this.bootstrapSession();
        hit.handled = "resolved";
        frame.report.recoveries.push(hit);
        this.recoveries.push(hit);
        if (handler.then === "restart") {
          const entry = this.resolveEntry();
          if (entry) {
            await this.o.surface.navigate(entry);
            await this.o.surface.settle();
          }
          return { kind: "restart" };
        }
        return { kind: "retry" };
      }
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
    if (!this.o.broker) {
      throw new RunFailure(
        "POLICY_BLOCKED",
        `${decision.reason}; no operator console is attached to approve it`,
      );
    }
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
      obs: {
        url: obs.url,
        landmark: obs.landmark,
        screenshot: shot,
        elements: obs.elements,
        png: obs.screenshotPlain,
      },
    });
    if (res === "abort")
      throw new RunFailure("HUMAN_ABORTED", `Operator aborted the run at "${step.name}"`);
    return res === "approve";
  }

  private async escalateFailure(
    frame: StepFrame,
    err: RunFailure,
    condition?: Condition,
  ): Promise<{ kind: "retry" } | { kind: "continue" } | { kind: "terminal"; result: RunResult }> {
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
      obs: {
        url: obs.url,
        landmark: obs.landmark,
        screenshot: shot,
        elements: obs.elements,
        png: obs.screenshotPlain,
      },
      condition,
    });
    switch (res) {
      case "retry":
        frame.report.status = "recovered";
        return { kind: "retry" };
      case "skip":
      case "resume":
        // The human completed this step manually; continue with the next one.
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
    obs: {
      url: string;
      landmark?: string;
      screenshot: string;
      elements: InterventionRequest["elements"];
      png: Buffer;
    };
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
          screenshot: a.obs.screenshot,
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
          screenshotPng: a.obs.png,
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
      if (req) this.o.evidence.saveJson(`interventions/${req.id}.json`, req);
      // After a human touched the session, re-settle before continuing.
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
          {
            expected: a.reason.expected,
            observed: a.reason.observed,
          },
        );
      }
      throw e;
    }
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
          {
            expected: describeExpectation(e),
            observed: r.observed,
          },
        );
      }
    }
    const missing = Object.keys(this.capability.outputs).filter((k) => !(k in this.outputs));
    if (missing.length) {
      throw new RunFailure(
        "OUTPUT_PARSE_ERROR",
        `Declared outputs were not extracted: ${missing.join(", ")}`,
      );
    }
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
      err.detail.cause = err.detail.cause ?? undefined;
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
      drift,
      evidence: { dir: this.o.evidence.dir, events: "events.jsonl" },
      policy: this.policyStats,
      ...extra,
    } as unknown as RunResult;
  }

  private async finish(result: RunResult): Promise<RunResult> {
    const { evidence } = this.o;
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
      },
    );
    return result;
  }
}

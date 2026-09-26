/**
 * Discovery engine: observe -> decide (LLM) -> policy gate -> act -> settle -> record.
 * Produces a capability artifact from ONE successful run, plus evidence of the run.
 */
import fs from "node:fs";
import path from "node:path";
import type { AppProfile, Capability, TenantBinding, Sensitivity } from "../core/schema.js";
import { Capability as CapabilitySchema } from "../core/schema.js";
import { resolveValue, type Params } from "../core/template.js";
import { RunFailure, errorMessage } from "../core/errors.js";
import type { InterventionSummary, RunError } from "../core/result.js";
import type { Observation, ElementInfo, Resolved, Surface } from "../surface/types.js";
import type { PlaywrightSurface } from "../surface/playwright.js";
import type { PolicyGate, ProposedAction, Decision } from "../policy/policy.js";
import type { EnvSecretStore } from "../policy/secrets.js";
import type { Redactor } from "../policy/redact.js";
import type { RunEvidence } from "../evidence/store.js";
import type { InterventionBroker, InterventionRequest, ResolutionKind } from "../hitl/broker.js";
import { InterventionTimeout } from "../hitl/broker.js";
import type { CapabilityStore } from "../catalog/store.js";
import { ensureAuthenticated } from "../replay/session.js";
import { parseValue } from "../replay/parse.js";
import { Recorder, inferParse } from "./recorder.js";
import type { ActionResult, AgentAction, Decider, LlmUsage } from "./decider.js";
import { ulid } from "../core/ids.js";
import { sleep, truncate } from "../core/util.js";

export interface DiscoveryOptions {
  goal: string;
  inputs: Record<string, string>;
  inputSensitivity?: Record<string, Sensitivity>;
  suggestedName?: string;
  profile: AppProfile;
  tenant: TenantBinding;
  surface: Surface;
  policy: PolicyGate;
  secrets: EnvSecretStore;
  redactor: Redactor;
  evidence: RunEvidence;
  broker: InterventionBroker | null;
  decider: Decider;
  store: CapabilityStore;
  maxSteps?: number;
  maxRunMs?: number;
  runId?: string;
  toolVersions?: Record<string, string>;
  /** Save the artifact into the catalog (default true). */
  persist?: boolean;
}

export interface DiscoveryResult {
  runId: string;
  kind: "discovery";
  status: "success" | "failure";
  goal: string;
  tenant: string;
  capability?: Capability;
  artifactPath?: string;
  error?: RunError;
  actions: number;
  turns: number;
  llm: LlmUsage;
  interventions: InterventionSummary[];
  policy: { decisions: number; denied: number; confirmations: number };
  evidence: { dir: string; events: string; transcript: string; artifact?: string; trace?: string };
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

interface Exec {
  result: ActionResult;
  terminal?: "done" | "gave_up";
  changed?: boolean;
}

export class DiscoveryEngine {
  private readonly runId: string;
  private readonly params: Params;
  private readonly recorder: Recorder;
  private readonly interventions: InterventionSummary[] = [];
  private readonly policyStats = { decisions: 0, denied: 0, confirmations: 0 };
  private actions = 0;
  private turns = 0;
  private readonly startedAt = new Date();
  private readonly maxSteps: number;
  private readonly maxRunMs: number;
  private lastObservation: Observation | null = null;
  private doneSummary: string | null = null;

  constructor(private readonly o: DiscoveryOptions) {
    this.runId = o.runId ?? ulid();
    this.params = { ...o.tenant.params, ...o.inputs };
    for (const [k, v] of Object.entries(o.inputs)) {
      const s = o.inputSensitivity?.[k];
      if (s && s !== "none") o.redactor.registerSensitive(v, s);
    }
    this.recorder = new Recorder(o.surface, this.params, o.tenant.baseUrl, o.profile.contentFrame);
    this.maxSteps = o.maxSteps ?? o.policy.config.limits.maxSteps;
    this.maxRunMs = o.maxRunMs ?? o.policy.config.limits.maxRunMs;
  }

  async run(): Promise<DiscoveryResult> {
    const { evidence } = this.o;
    evidence.emit(
      "run.start",
      `Discovery: "${this.o.goal}" on tenant ${this.o.tenant.id} with ${this.o.decider.kind} decider (${this.o.decider.model})`,
      {
        goal: this.o.goal,
        tenant: this.o.tenant.id,
        inputs: this.o.inputs,
        decider: { kind: this.o.decider.kind, model: this.o.decider.model },
        maxSteps: this.maxSteps,
      },
    );
    try {
      await this.bootstrap();
      await this.o.decider.start(
        {
          goal: this.o.goal,
          inputs: this.o.inputs,
          app: this.o.profile.displayName,
          tenant: this.o.tenant.displayName,
          secretRefs: this.o.secrets.refs().filter((r) => r !== "teller_password"),
          maxSteps: this.maxSteps,
        },
        evidence,
      );
      await this.loop();
      const cap = await this.finalize();
      return this.finish({ status: "success", capability: cap.capability, artifactPath: cap.path });
    } catch (e) {
      const err =
        e instanceof RunFailure
          ? e
          : new RunFailure("SURFACE_ERROR", errorMessage(e), { cause: e });
      const files: string[] = [];
      try {
        files.push(
          evidence.saveScreenshot("fail-final", await this.o.surface.screenshot(), "failure"),
        );
        files.push(evidence.saveText("failure/dom-final.html", await this.o.surface.domSnapshot()));
      } catch {
        /* surface gone */
      }
      return this.finish({
        status: "failure",
        error: {
          code: err.code,
          message: err.message,
          expected: err.detail.expected,
          observed: err.detail.observed,
          evidence: files,
        },
      });
    }
  }

  private policyCtx() {
    return { mode: "discovery" as const };
  }

  private async bootstrap(): Promise<void> {
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
    // Recordings must start from a defined screen (the app entry), never from whatever the
    // previous run left in the browser, so the first step's pre-condition is reproducible.
    const entry = resolveValue(
      this.o.profile.session.login.entry,
      this.params,
      this.o.secrets,
    ).value;
    await this.o.surface.navigate(entry);
    await this.o.surface.settle();
  }

  private async loop(): Promise<void> {
    const { surface, evidence, decider } = this.o;
    let results: ActionResult[] = [];
    let note: string | undefined;
    let prevHash: string | undefined;
    let sameCount = 0;
    const history: string[] = [];
    for (;;) {
      this.turns++;
      if (this.actions >= this.maxSteps)
        throw new RunFailure(
          "MAX_STEPS",
          `Reached the ${this.maxSteps}-action budget without completing the goal`,
        );
      if (Date.now() - this.startedAt.getTime() > this.maxRunMs)
        throw new RunFailure("TIMEOUT", `Discovery exceeded ${this.maxRunMs}ms`);

      const obs = await surface.observe({ marks: true });
      this.lastObservation = obs;
      this.recorder.completePending(obs);
      const shot = evidence.saveScreenshot(
        `${String(this.turns).padStart(2, "0")}-observe`,
        obs.screenshot,
      );
      const contentUrl =
        obs.frames.find((f) => f.path.join("/") === this.o.profile.contentFrame.join("/"))?.url ??
        obs.url;
      evidence.emit(
        "agent.observe",
        `Turn ${this.turns}: ${contentUrl} heading="${obs.landmark ?? ""}" elements=${obs.elements.length} hash=${obs.hash}`,
        {
          turn: this.turns,
          url: obs.url,
          landmark: obs.landmark,
          frames: obs.frames.map((f) => ({ path: f.path, url: f.url })),
          elements: obs.elements.length,
          hash: obs.hash,
          screenshot: shot,
          dialogs: obs.dialogs,
        },
      );

      const acted = results.some((r) => !r.isError);
      if (acted && obs.hash === prevHash) sameCount++;
      else sameCount = 0;
      prevHash = obs.hash;
      if (sameCount >= 3) {
        note = await this.stuck(
          "The screen has not changed after 3 consecutive actions.",
          obs,
          shot,
        );
        sameCount = 0;
      }

      const actions = await decider.decide({
        observation: obs,
        results,
        note,
        stepNumber: this.turns,
        screenshotRef: shot,
      });
      note = undefined;
      evidence.emit(
        "agent.decide",
        `Turn ${this.turns}: ${actions.map((a) => summarize(a)).join(" ; ")}`,
        { turn: this.turns, actions },
      );

      results = [];
      let terminal: Exec["terminal"] | undefined;
      let changed = false;
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]!;
        if (terminal) {
          results.push({ id: action.id, text: "Not executed: the run has ended.", isError: true });
          continue;
        }
        if (changed) {
          results.push({
            id: action.id,
            text: "Not executed: the page changed after the previous action. Look at the new screen and decide again.",
            isError: true,
          });
          continue;
        }
        const sig = signature(action);
        history.push(sig);
        if (
          history.length >= 3 &&
          history.slice(-3).every((s) => s === sig) &&
          action.tool !== "wait"
        ) {
          note = await this.stuck(
            `The same action (${summarize(action)}) was attempted 3 times in a row.`,
            obs,
            shot,
          );
        }
        const ex = await this.execute(action, obs, i);
        results.push(ex.result);
        if (ex.terminal) terminal = ex.terminal;
        if (ex.changed) changed = true;
      }
      if (terminal === "done") return;
    }
  }

  private async stuck(why: string, obs: Observation, shot: string): Promise<string | undefined> {
    if (!this.o.broker) throw new RunFailure("UNKNOWN_STATE", `Stuck: ${why}`);
    const res = await this.raise({
      type: "stuck",
      reason: { code: "STUCK", message: why },
      allowed: ["resume", "abort"],
      obs,
      shot,
    });
    if (res.kind === "abort")
      throw new RunFailure("HUMAN_ABORTED", `Operator aborted the discovery (${why})`);
    return res.note;
  }

  private async raise(a: {
    type: InterventionRequest["type"];
    reason: InterventionRequest["reason"];
    allowed: ResolutionKind[];
    obs: Observation;
    shot: string;
  }): Promise<{ kind: ResolutionKind; note?: string }> {
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
    broker.once("raised", (req: InterventionRequest) => (summary.id = req.id));
    try {
      const res = await broker.raise(
        {
          runId: this.runId,
          runKind: "discovery",
          type: a.type,
          capability: null,
          goal: this.o.goal,
          tenant: this.o.tenant.id,
          step: {
            id: `turn-${this.turns}`,
            index: this.actions,
            name: `turn ${this.turns}`,
            kind: "agent",
          },
          reason: a.reason,
          url: a.obs.url,
          landmark: a.obs.landmark,
          screenshot: a.shot,
          elements: a.obs.elements
            .filter((e) => e.interactive)
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
      if (req) this.o.evidence.saveJson(`interventions/${req.id}.json`, req);
      await this.o.surface.settle();
      const humanNote =
        req && req.humanActions.length
          ? `A human operator took control of the session and performed ${req.humanActions.length} action(s): ${req.humanActions
              .map(
                (h) =>
                  `${h.kind}${h.element ? ` on ${h.element.role} "${h.element.name || h.element.text}"` : ""}`,
              )
              .join(", ")}. `
          : "";
      return {
        kind: res.kind,
        note: `${humanNote}${res.note ? `Operator note: ${res.note}. ` : ""}Continue from the current screen.`,
      };
    } catch (e) {
      if (e instanceof InterventionTimeout)
        throw new RunFailure("ESCALATION_TIMEOUT", `No operator responded: ${a.reason.message}`);
      throw e;
    }
  }

  private async gate(
    action: AgentAction,
    el: ElementInfo | null,
    obs: Observation,
    shot: string,
  ): Promise<
    { ok: true; risk: Decision["risk"]; approved?: boolean } | { ok: false; text: string }
  > {
    const kind =
      action.tool === "type_secret"
        ? "type"
        : action.tool === "give_up" || action.tool === "done" || action.tool === "request_human"
          ? null
          : action.tool;
    if (!kind) return { ok: true, risk: "safe" };
    const proposed: ProposedAction = {
      kind,
      url: action.tool === "navigate" ? action.url : this.o.surface.currentUrl(el?.frame),
      controlName: el ? el.name || el.labelText || el.text || undefined : undefined,
      controlRole: el?.role,
      formSubmitLabels: el?.formSubmitLabels,
      pressEnter:
        (action.tool === "type" && action.press_enter) ||
        (action.tool === "press" && action.key === "Enter"),
    };
    const decision = this.o.policy.evaluate(proposed, this.policyCtx());
    this.policyStats.decisions++;
    this.o.evidence.emit(
      "policy.decision",
      `${summarize(action)} → ${decision.verdict} (${decision.rule}, risk=${decision.risk})`,
      { action: summarize(action), decision },
    );
    if (decision.verdict === "deny") {
      this.policyStats.denied++;
      return {
        ok: false,
        text: `POLICY DENIED: ${decision.reason}. Choose a different action that stays within policy.`,
      };
    }
    if (decision.verdict === "confirm") {
      this.policyStats.confirmations++;
      if (!this.o.broker)
        return {
          ok: false,
          text: `POLICY: ${decision.reason} requires an operator's approval and no operator console is attached. Do not retry it.`,
        };
      const res = await this.raise({
        type: "approval",
        reason: { code: "APPROVAL_REQUIRED", message: `${decision.reason} (${decision.rule})` },
        allowed: ["approve", "deny", "abort"],
        obs,
        shot,
      });
      if (res.kind === "abort")
        throw new RunFailure("HUMAN_ABORTED", `Operator aborted at ${summarize(action)}`);
      if (res.kind !== "approve")
        return {
          ok: false,
          text: `The operator DENIED the ${decision.risk} action "${proposed.controlName ?? action.tool}". Do not retry it; find another way or give_up.`,
        };
      // The operator approved this exact action, which covers the confirm() it opens.
      return { ok: true, risk: decision.risk, approved: true };
    }
    return { ok: true, risk: decision.risk };
  }

  private async execute(action: AgentAction, obs: Observation, idx: number): Promise<Exec> {
    const { surface, evidence } = this.o;
    const shotRef = `${String(this.turns).padStart(2, "0")}-observe.png`;
    const turnLabel = `${String(this.turns).padStart(2, "0")}-${idx + 1}`;
    const fail = (text: string): Exec => ({ result: { id: action.id, text, isError: true } });

    if (action.tool === "done") {
      let el: ElementInfo | null = null;
      try {
        el = (await surface.resolveRef(obs, action.evidence_ref)).element;
      } catch {
        return fail(
          `evidence_ref ${action.evidence_ref} is not on the current screen. Pick an element from the current observation.`,
        );
      }
      this.recorder.recordAction(action, el, obs, "safe", []);
      this.doneSummary = action.summary;
      evidence.emit(
        "agent.act",
        `done: ${action.summary} (evidence: ${el?.role} "${el?.text || el?.name}")`,
        { summary: action.summary, evidence: action.evidence_ref },
      );
      return { result: { id: action.id, text: "Recorded." }, terminal: "done" };
    }
    if (action.tool === "give_up") {
      evidence.emit("agent.act", `give_up (${action.kind}): ${action.reason}`, {
        kind: action.kind,
        reason: action.reason,
      });
      throw new RunFailure("AGENT_GAVE_UP", `[${action.kind}] ${action.reason}`);
    }
    if (action.tool === "request_human") {
      evidence.emit("agent.act", `request_human: ${action.reason}`, { reason: action.reason });
      const res = await this.raise({
        type: "agent_request",
        reason: { code: "AGENT_REQUEST", message: action.reason },
        allowed: ["resume", "abort"],
        obs,
        shot: `steps/${shotRef}`,
      });
      if (res.kind === "abort")
        throw new RunFailure(
          "HUMAN_ABORTED",
          `Operator aborted after the agent asked for help: ${action.reason}`,
        );
      return {
        result: { id: action.id, text: `Human operator handed control back. ${res.note ?? ""}` },
        changed: true,
      };
    }
    if (action.tool === "wait") {
      await sleep(Math.min(10, Math.max(1, action.seconds)) * 1000);
      await surface.settle();
      return { result: { id: action.id, text: `Waited ${action.seconds}s.` }, changed: true };
    }

    let resolved: Resolved | null = null;
    const el = "ref" in action ? (obs.elements.find((e) => e.ref === action.ref) ?? null) : null;
    if ("ref" in action) {
      if (!el) return fail(`Unknown ref ${action.ref}. Use a ref from the current screen.`);
      try {
        resolved = await surface.resolveRef(obs, action.ref);
      } catch (e) {
        return fail(
          `Element ${action.ref} is no longer on the screen (${errorMessage(e)}). Look at the new screen.`,
        );
      }
    }
    const gate = await this.gate(action, el, obs, `steps/${shotRef}`);
    if (!gate.ok) return fail(gate.text);

    const before = obs.hash;
    let text: string;
    let extra: { raw?: string; value?: unknown } | undefined;
    try {
      switch (action.tool) {
        case "click":
          surface.expectDialog(
            action.accept_dialog || gate.approved
              ? { messagePattern: ".*", response: "accept" }
              : null,
          );
          try {
            await surface.click(resolved!);
          } finally {
            surface.expectDialog(null);
          }
          text = `Clicked ${action.ref} (${el!.role} "${truncate(el!.name || el!.text, 40)}").`;
          break;
        case "type":
          await surface.type(resolved!, action.text, {
            clear: true,
            pressEnter: action.press_enter,
          });
          text = `Typed "${action.text}" into ${action.ref}${action.press_enter ? " and pressed Enter" : ""}.`;
          break;
        case "type_secret": {
          if (!this.o.secrets.has(action.secret))
            return fail(
              `Unknown secret "${action.secret}". Available: ${this.o.secrets.refs().join(", ") || "none"}.`,
            );
          const value = this.o.secrets.resolve(action.secret);
          await surface.type(resolved!, value, { clear: true });
          text = `Typed secret ${action.secret} into ${action.ref}.`;
          break;
        }
        case "select":
          await surface.select(resolved!, action.value);
          text = `Selected "${action.value}" in ${action.ref}.`;
          break;
        case "press":
          await surface.press(action.key);
          text = `Pressed ${action.key}.`;
          break;
        case "navigate":
          await surface.navigate(action.url);
          text = `Navigated to ${action.url}.`;
          break;
        case "extract": {
          const raw = await surface.readText(resolved!);
          const parse = action.parse ?? inferParse(raw);
          let value: unknown;
          try {
            value = parseValue(raw, { type: parse });
          } catch (e) {
            return fail(
              `Could not parse "${raw}" as ${parse}: ${errorMessage(e)}. Pick the element holding just the value, or a different parse.`,
            );
          }
          extra = { raw, value };
          text = `Extracted ${action.output} = ${JSON.stringify(value)} (raw "${truncate(raw, 60)}").`;
          break;
        }
      }
    } catch (e) {
      return fail(`Action failed: ${errorMessage(e)}`);
    }
    await surface.settle();
    const dialogs = surface.takeDialogs();
    for (const d of dialogs) {
      evidence.emit(
        "dialog",
        `${d.type} dialog "${truncate(d.message, 80)}" → ${d.response}${d.expected ? ` (accepted ${gate.approved ? "under operator approval" : "per agent request"})` : " (dismissed: not pre-approved)"}`,
        { dialog: d },
      );
      text += d.expected
        ? ` A ${d.type} dialog "${truncate(d.message, 80)}" was accepted.`
        : ` A ${d.type} dialog "${truncate(d.message, 80)}" appeared and was DISMISSED (cancelled) because dialogs are not accepted automatically.`;
    }
    this.actions++;
    const step = this.recorder.recordAction(action, el, obs, gate.risk, dialogs, extra);
    const after = await surface.screenshot();
    const afterRef = evidence.saveScreenshot(`${turnLabel}-after-${action.tool}`, after);
    evidence.emit("agent.act", `${summarize(action)} → ${text}`, {
      action: summarize(action),
      why: "why" in action ? action.why : undefined,
      stepId: step?.id,
      screenshot: afterRef,
      risk: gate.risk,
    });
    if (step)
      evidence.emit("recorder.step", `Recorded step ${step.id}: ${step.name}`, {
        step: this.o.redactor.redact(stripVisual(step)),
      });
    // Cheap change detection without a full observation: compare the content frame URL + dialogs.
    const changed =
      surface.currentUrl() !==
        obs.frames.find((f) => f.path.join("/") === this.o.profile.contentFrame.join("/"))?.url ||
      dialogs.length > 0 ||
      before !== obs.hash;
    return {
      result: { id: action.id, text },
      changed:
        changed ||
        action.tool === "click" ||
        action.tool === "navigate" ||
        action.tool === "press" ||
        (action.tool === "type" && !!action.press_enter),
    };
  }

  private async finalize(): Promise<{ capability: Capability; path?: string }> {
    const { evidence, decider, store } = this.o;
    const finalObs = this.lastObservation!;
    this.recorder.flush(finalObs);
    if (this.recorder.steps.length === 0)
      throw new RunFailure("AGENT_GAVE_UP", "The agent declared done without taking any action");
    const checkpoint = this.recorder.buildCheckpoint(finalObs);
    evidence.emit(
      "agent.finalize",
      `Finalising contract for ${this.recorder.steps.length} steps, ${this.recorder.outputs.length} outputs`,
      {
        steps: this.recorder.steps.map((s) => ({ id: s.id, kind: s.kind, name: s.name })),
        outputs: this.recorder.outputs,
        checkpoint,
        summary: this.doneSummary,
      },
    );
    const contract = await decider.finalize({
      goal: this.o.goal,
      inputs: this.o.inputs,
      steps: this.recorder.steps,
      outputs: this.recorder.outputs,
      app: this.o.profile.displayName,
      suggestedName: this.o.suggestedName,
    });
    if (this.o.suggestedName) contract.name = this.o.suggestedName;
    const capability = this.recorder.assemble({
      contract,
      version: store.nextVersion(contract.name),
      goal: this.o.goal,
      profileId: this.o.profile.id,
      surface: this.o.profile.surface,
      family: this.o.profile.family,
      tenant: this.o.tenant.id,
      runId: this.runId,
      decider: { kind: decider.kind, model: decider.model },
      checkpoint,
      allowedOrigins: this.o.policy.config.allow.origins,
      inputSensitivity: this.o.inputSensitivity ?? {},
      tenantParamNames: Object.keys(this.o.tenant.params),
      toolVersions: this.o.toolVersions ?? {},
    });
    const parsed = CapabilitySchema.parse(capability);
    let saved: string | undefined;
    if (this.o.persist !== false) saved = store.save(parsed, this.o.redactor);
    evidence.saveJson("artifact.json", parsed);
    evidence.emit(
      "agent.finalize",
      `Capability ${parsed.name}@${parsed.version} recorded (${parsed.steps.length} steps, risk=${parsed.policy.riskClass})${saved ? ` → ${saved}` : ""}`,
      {
        name: parsed.name,
        version: parsed.version,
        steps: parsed.steps.length,
        inputs: Object.keys(parsed.inputs),
        outputs: Object.keys(parsed.outputs),
        riskClass: parsed.policy.riskClass,
        file: saved,
      },
    );
    return { capability: parsed, path: saved };
  }

  private async finish(extra: Partial<DiscoveryResult>): Promise<DiscoveryResult> {
    const { evidence } = this.o;
    const endedAt = new Date();
    const transcript = evidence.saveJson("transcript.json", this.o.decider.transcript());
    const surface = this.o.surface as Partial<PlaywrightSurface>;
    let trace: string | undefined;
    if (typeof surface.stopTrace === "function") {
      const tracePath = evidence.filePath("trace.zip");
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      if (await surface.stopTrace(tracePath)) trace = "trace.zip";
    }
    const result: DiscoveryResult = {
      runId: this.runId,
      kind: "discovery",
      status: "failure",
      goal: this.o.goal,
      tenant: this.o.tenant.id,
      actions: this.actions,
      turns: this.turns,
      llm: this.o.decider.usage(),
      interventions: this.interventions,
      policy: this.policyStats,
      evidence: {
        dir: evidence.dir,
        events: "events.jsonl",
        transcript,
        ...(extra.capability ? { artifact: "artifact.json" } : {}),
        ...(trace ? { trace } : {}),
      },
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - this.startedAt.getTime(),
      ...extra,
    } as DiscoveryResult;
    evidence.saveJson("result.json", {
      ...result,
      capability: result.capability
        ? {
            name: result.capability.name,
            version: result.capability.version,
            id: result.capability.id,
          }
        : undefined,
    });
    evidence.emit(
      "run.end",
      `Discovery ended: ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ""} after ${result.actions} actions / ${result.llm.calls} model calls in ${result.durationMs}ms`,
      {
        status: result.status,
        error: result.error,
        actions: result.actions,
        llm: result.llm,
        interventions: result.interventions,
      },
    );
    return result;
  }
}

function summarize(a: AgentAction): string {
  switch (a.tool) {
    case "click":
      return `click ${a.ref}${a.accept_dialog ? " (accept dialog)" : ""}`;
    case "type":
      return `type "${truncate(a.text, 30)}" into ${a.ref}${a.press_enter ? " + Enter" : ""}`;
    case "type_secret":
      return `type_secret ${a.secret} into ${a.ref}`;
    case "select":
      return `select "${a.value}" in ${a.ref}`;
    case "press":
      return `press ${a.key}`;
    case "navigate":
      return `navigate ${a.url}`;
    case "extract":
      return `extract ${a.output} from ${a.ref}`;
    case "wait":
      return `wait ${a.seconds}s`;
    case "done":
      return `done (${truncate(a.summary, 60)})`;
    case "request_human":
      return `request_human (${truncate(a.reason, 60)})`;
    case "give_up":
      return `give_up ${a.kind} (${truncate(a.reason, 60)})`;
  }
}

function signature(a: AgentAction): string {
  return JSON.stringify({ ...a, id: undefined, why: undefined });
}

function stripVisual<T>(step: T): T {
  return JSON.parse(
    JSON.stringify(step, (k, v) =>
      k === "template" && typeof v === "string" && v.length > 64 ? `[png ${v.length}b]` : v,
    ),
  ) as T;
}

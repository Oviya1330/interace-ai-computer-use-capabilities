/**
 * Probe phase: after a successful discovery, replay the new artifact deterministically with
 * deliberately "bad" inputs (unknown record, invalid amount). Where replay stops in an
 * unknown state, ONE bounded model call classifies the screen into the error taxonomy and
 * the resulting condition (detector + class + handler) is appended to the artifact. The
 * model runs at authoring time only; production replay stays model-free.
 */
import type { AppProfile, Capability, Condition, TenantBinding } from "../core/schema.js";
import { FailureCodes, type RunResult } from "../core/result.js";
import { parameterize } from "../core/template.js";
import type { Surface } from "../surface/types.js";
import type { PolicyGate } from "../policy/policy.js";
import type { EnvSecretStore } from "../policy/secrets.js";
import type { Redactor } from "../policy/redact.js";
import type { RunEvidence } from "../evidence/store.js";
import { ReplayEngine } from "../replay/engine.js";
import type { ConditionProposal, Decider } from "./decider.js";
import { errorMessage } from "../core/errors.js";

export interface ProbeOptions {
  name: string;
  capability: Capability;
  inputs: Record<string, string>;
  profile: AppProfile;
  tenant: TenantBinding;
  surface: Surface;
  policy: PolicyGate;
  secrets: EnvSecretStore;
  redactor: Redactor;
  evidence: RunEvidence;
  decider: Decider;
}

export interface ProbeResult {
  name: string;
  replay: RunResult;
  proposal?: ConditionProposal;
  condition?: Condition;
  note: string;
}

export async function runProbe(o: ProbeOptions): Promise<ProbeResult> {
  const { evidence } = o;
  evidence.emit(
    "run.start",
    `Probe "${o.name}": replaying ${o.capability.name} with ${JSON.stringify(o.inputs)}`,
    { probe: o.name, inputs: o.inputs },
  );
  const replay = await new ReplayEngine({
    capability: o.capability,
    profile: o.profile,
    tenant: o.tenant,
    inputs: o.inputs,
    surface: o.surface,
    policy: o.policy,
    secrets: o.secrets,
    redactor: o.redactor,
    evidence: o.evidence,
    broker: null,
  }).run();

  if (replay.status !== "failure") {
    const note =
      replay.status === "success"
        ? "Probe inputs completed the flow; nothing to learn."
        : `Already classified by condition "${replay.outcome.conditionId}" (${replay.outcome.code}).`;
    evidence.emit("run.end", `Probe "${o.name}": ${note}`, {
      probe: o.name,
      status: replay.status,
    });
    return { name: o.name, replay, note };
  }

  const obs = await o.surface.observe({ marks: true });
  const shot = evidence.saveScreenshot(`probe-${o.name}-state`, obs.screenshot, "probes");
  let proposal: ConditionProposal;
  try {
    proposal = await o.decider.classify({
      goal: o.capability.goal,
      inputs: o.inputs,
      observation: obs,
      failure: {
        code: replay.error.code,
        message: replay.error.message,
        stepName: replay.error.stepName,
      },
    });
  } catch (e) {
    const note = `Classification failed: ${errorMessage(e)}`;
    evidence.emit("error", note);
    return { name: o.name, replay, note };
  }
  evidence.emit(
    "agent.finalize",
    `Probe "${o.name}" classified as ${proposal.class} ${proposal.code}: ${proposal.description}`,
    { probe: o.name, proposal, screenshot: shot },
  );

  const params = { ...o.tenant.params, ...o.inputs };
  const contentFrame = o.profile.contentFrame;
  const candidates = [parameterize(proposal.detectorText, params), proposal.detectorText];
  let detectText: string | null = null;
  for (const c of candidates) {
    const r = await o.surface.check({ kind: "text", text: c, frame: contentFrame }, params, {
      timeoutMs: 0,
    });
    if (r.ok) {
      detectText = c;
      break;
    }
  }
  if (!detectText) {
    const note = `Proposed detector text "${proposal.detectorText}" is not visible on the current screen; condition discarded.`;
    evidence.emit("drift.warning", note, { probe: o.name });
    return { name: o.name, replay, proposal, note };
  }

  const id = proposal.code.toLowerCase();
  const condition: Condition = {
    id,
    description: proposal.description,
    detect: { kind: "text", text: detectText, frame: contentFrame },
    class: proposal.class,
    origin: "probe",
    ...(proposal.class === "business_outcome"
      ? { outcome: { code: proposal.code, message: proposal.message } }
      : {}),
    ...(proposal.class === "hard_failure"
      ? {
          failureCode: (FailureCodes as readonly string[]).includes(proposal.code)
            ? proposal.code
            : "UNKNOWN_STATE",
        }
      : {}),
  };
  if (proposal.class === "recoverable") {
    const el = proposal.dismissRef
      ? obs.elements.find((e) => e.ref === proposal.dismissRef)
      : undefined;
    if (el) {
      condition.handler = {
        kind: "dismiss",
        target: o.surface.describeTarget(el, params, obs.screenshotPlain),
        then: "retry_step",
      };
      condition.safeAfterMutation = true;
    } else {
      condition.handler = { kind: "escalate", reason: proposal.message };
    }
  }
  const existing = o.capability.conditions.findIndex((c) => c.id === id);
  if (existing >= 0) o.capability.conditions[existing] = condition;
  else o.capability.conditions.unshift(condition);
  evidence.saveJson(`probes/${o.name}.json`, {
    inputs: o.inputs,
    replay: { status: replay.status, error: replay.error },
    proposal,
    condition,
  });
  const note = `Learned condition "${id}" (${condition.class}) from probe "${o.name}".`;
  evidence.emit("run.end", note, { probe: o.name, condition: id, class: condition.class });
  return { name: o.name, replay, proposal, condition, note };
}

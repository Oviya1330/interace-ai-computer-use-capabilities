/** Programmatic entry points shared by the CLI, the demo script and the tests. */
import fs from "node:fs";
import path from "node:path";
import { createRuntime, type Runtime } from "../runtime.js";
import { DiscoveryEngine, type DiscoveryResult } from "../agent/loop.js";
import { ReplayEngine } from "../replay/engine.js";
import { runProbe, type ProbeResult } from "../agent/probe.js";
import { LlmDecider, toolVersions } from "../agent/llm.js";
import { SCRIPTED_FLOWS } from "../agent/scripts.js";
import type { Decider } from "../agent/decider.js";
import type { RunResult } from "../core/result.js";
import type { Capability, Sensitivity } from "../core/schema.js";
import { ulid } from "../core/ids.js";

export interface ChaosSpec {
  scenario: string;
  count?: number;
  pathPattern?: string;
  delayMs?: number;
}

/** Test hook on the mock app: arm a runtime fault for the next N page requests. */
export async function armChaos(baseUrl: string, chaos: ChaosSpec): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const res = await fetch(`${origin}/__chaos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario: chaos.scenario,
      count: chaos.count ?? 1,
      ...(chaos.pathPattern ? { pathPattern: chaos.pathPattern } : {}),
      ...(chaos.delayMs ? { delayMs: chaos.delayMs } : {}),
    }),
  });
  if (!res.ok) throw new Error(`chaos hook failed: ${res.status} ${await res.text()}`);
}

/** Test hook on the mock app: restore seed data, sessions and chaos state. */
export async function resetApp(baseUrl: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const res = await fetch(`${origin}/__reset`, { method: "POST" });
  if (!res.ok) throw new Error(`reset hook failed: ${res.status}`);
}

export async function resetChaos(baseUrl: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  await fetch(`${origin}/__chaos/reset`, { method: "POST" }).catch(() => {});
}

export interface DiscoverArgs {
  goal: string;
  tenant: string;
  inputs: Record<string, string>;
  sensitive?: string[];
  name?: string;
  probes?: Array<{ name: string; inputs: Record<string, string> }>;
  decider: string; // "llm" | "scripted:<flow>"
  headed?: boolean;
  console?: boolean;
  evidenceRoot?: string;
  label?: string;
  maxSteps?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  policyFile?: string;
  runtime?: Runtime;
  log?: (line: string) => void;
}

export interface DiscoverOutcome {
  result: DiscoveryResult;
  probes: ProbeResult[];
  capability?: Capability;
  artifactPath?: string;
}

export function makeDecider(
  spec: string,
  inputs: Record<string, string>,
  contentFrame: string[],
  opts: { model?: string; effort?: DiscoverArgs["effort"] },
): Decider {
  if (spec === "llm")
    return new LlmDecider({ contentFrame, model: opts.model, effort: opts.effort });
  const m = /^scripted:([a-z_]+)$/.exec(spec);
  if (!m)
    throw new Error(
      `Unknown decider "${spec}" (use llm or scripted:<${Object.keys(SCRIPTED_FLOWS).join("|")}>)`,
    );
  const flow = SCRIPTED_FLOWS[m[1]!];
  if (!flow)
    throw new Error(
      `Unknown scripted flow "${m[1]}"; available: ${Object.keys(SCRIPTED_FLOWS).join(", ")}`,
    );
  return flow(inputs);
}

export async function discoverCommand(a: DiscoverArgs): Promise<DiscoverOutcome> {
  const log = a.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const rt =
    a.runtime ??
    (await createRuntime({
      tenantId: a.tenant,
      headless: !a.headed,
      console: a.console,
      evidenceRoot: a.evidenceRoot,
      policyFile: a.policyFile,
    }));
  const own = !a.runtime;
  try {
    if (rt.console) log(`[cua] operator console: ${rt.console.url}`);
    const runId = ulid();
    const evidence = rt.newEvidence(runId, a.label ?? `discovery-${runId}`);
    const decider = makeDecider(a.decider, a.inputs, rt.profile.contentFrame, {
      model: a.model,
      effort: a.effort,
    });
    const inputSensitivity: Record<string, Sensitivity> = {};
    for (const s of a.sensitive ?? []) inputSensitivity[s] = "pii";
    rt.session?.setParams({ ...rt.tenant.params, ...a.inputs });
    rt.session?.setEvidence(evidence);
    evidence.onEvent((e) => log(`  ${e.type.padEnd(20)} ${e.msg}`));
    const engine = new DiscoveryEngine({
      goal: a.goal,
      inputs: a.inputs,
      inputSensitivity,
      suggestedName: a.name,
      profile: rt.profile,
      tenant: rt.tenant,
      surface: rt.surface,
      policy: rt.policy,
      secrets: rt.secrets,
      redactor: rt.redactor,
      evidence,
      broker: rt.broker,
      decider,
      store: rt.store,
      maxSteps: a.maxSteps,
      runId,
      toolVersions: toolVersions(),
    });
    const result = await engine.run();
    const probes: ProbeResult[] = [];
    let capability = result.capability;
    if (result.status === "success" && capability && a.probes?.length) {
      for (const p of a.probes) {
        const pe = rt.newEvidence(
          `${runId}-probe-${p.name}`,
          `${a.label ?? `discovery-${runId}`}-probe-${p.name}`,
        );
        pe.onEvent((e) => log(`  ${e.type.padEnd(20)} ${e.msg}`));
        const pr = await runProbe({
          name: p.name,
          capability,
          inputs: { ...a.inputs, ...p.inputs },
          profile: rt.profile,
          tenant: rt.tenant,
          surface: rt.surface,
          policy: rt.policy,
          secrets: rt.secrets,
          redactor: rt.redactor,
          evidence: pe,
          decider,
        });
        probes.push(pr);
        log(`[cua] probe ${p.name}: ${pr.note}`);
      }
      capability = { ...capability };
      const saved = rt.store.save(capability, rt.redactor);
      evidence.saveJson("artifact.json", capability);
      result.artifactPath = saved;
    }
    return { result, probes, capability, artifactPath: result.artifactPath };
  } finally {
    if (own) await rt.close();
  }
}

export interface ReplayArgs {
  capability: string;
  tenant: string;
  inputs: Record<string, unknown>;
  approve?: string;
  chaos?: ChaosSpec;
  times?: number;
  headed?: boolean;
  console?: boolean;
  evidenceRoot?: string;
  label?: string;
  policyFile?: string;
  runtime?: Runtime;
  log?: (line: string) => void;
}

export async function replayCommand(a: ReplayArgs): Promise<RunResult[]> {
  const log = a.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const rt =
    a.runtime ??
    (await createRuntime({
      tenantId: a.tenant,
      headless: !a.headed,
      console: a.console,
      evidenceRoot: a.evidenceRoot,
      policyFile: a.policyFile,
    }));
  const own = !a.runtime;
  try {
    if (rt.console) log(`[cua] operator console: ${rt.console.url}`);
    const cap = rt.store.load(a.capability);
    const results: RunResult[] = [];
    const times = Math.max(1, a.times ?? 1);
    for (let i = 0; i < times; i++) {
      if (a.chaos) {
        await armChaos(rt.tenant.baseUrl, a.chaos);
        log(
          `[cua] chaos armed on the mock app: ${a.chaos.scenario} x${a.chaos.count ?? 1}${a.chaos.pathPattern ? ` on ${a.chaos.pathPattern}` : ""}`,
        );
      }
      const runId = ulid();
      const label = (a.label ?? `replay-${cap.name}-${runId}`) + (times > 1 ? `-${i + 1}` : "");
      const evidence = rt.newEvidence(runId, label);
      evidence.onEvent((e) => log(`  ${e.type.padEnd(20)} ${e.msg}`));
      rt.session?.setParams({
        ...rt.tenant.params,
        ...Object.fromEntries(Object.entries(a.inputs).map(([k, v]) => [k, String(v)])),
      });
      rt.session?.setEvidence(evidence);
      const engine = new ReplayEngine({
        capability: cap,
        profile: rt.profile,
        tenant: rt.tenant,
        inputs: a.inputs,
        surface: rt.surface,
        policy: rt.policy,
        secrets: rt.secrets,
        redactor: rt.redactor,
        evidence,
        broker: rt.broker,
        approval: a.approve ? { by: process.env.USER ?? "caller", reason: a.approve } : undefined,
        runId,
      });
      const result = await engine.run();
      results.push(result);
      updateStats(rt, cap, result);
    }
    return results;
  } finally {
    if (own) await rt.close();
  }
}

/**
 * Drift → specialisation: turn the fallback resolutions of a replay on another tenant into
 * tenant overrides. Changes replay behaviour, so the version is bumped and approval reset.
 */
export function promoteOverrides(
  cap: Capability,
  tenant: string,
  result: RunResult,
): { capability: Capability; promoted: string[] } {
  if (result.tenant !== tenant)
    throw new Error(`run was executed on tenant ${result.tenant}, not ${tenant}`);
  const proposals = result.steps.filter((s) => s.proposedOverride);
  const existing = cap.overrides[tenant] ?? { steps: {}, conditions: [] };
  const promoted: string[] = [];
  for (const p of proposals) {
    existing.steps[p.stepId] = {
      ...(existing.steps[p.stepId] ?? {}),
      target: p.proposedOverride!.target,
    };
    promoted.push(p.stepId);
  }
  if (promoted.length === 0) return { capability: cap, promoted };
  const [maj, min] = cap.version.split(".").map(Number);
  return {
    capability: {
      ...cap,
      overrides: { ...cap.overrides, [tenant]: existing },
      version: `${maj}.${(min ?? 0) + 1}.0`,
      status: "draft",
      review: { notes: `overrides for ${tenant} promoted from run ${result.runId}` },
    },
    promoted,
  };
}

function updateStats(rt: Runtime, cap: Capability, result: RunResult): void {
  try {
    const file = path.join(rt.store.dir, `${cap.name}@${cap.version}.json`);
    if (!fs.existsSync(file)) return;
    const fresh = rt.store.load(file);
    fresh.stats.replays++;
    if (result.status === "success") fresh.stats.successes++;
    else if (result.status === "business_outcome") fresh.stats.businessOutcomes++;
    else fresh.stats.failures++;
    fresh.stats.lastReplayAt = result.endedAt;
    fresh.stats.stabilityScore = Number(
      ((fresh.stats.successes + fresh.stats.businessOutcomes) / fresh.stats.replays).toFixed(3),
    );
    rt.store.save(fresh, rt.redactor);
  } catch {
    /* stats are advisory */
  }
}

export function formatResult(r: RunResult): string {
  const lines: string[] = [];
  const head =
    r.status === "success"
      ? "SUCCESS"
      : r.status === "business_outcome"
        ? `BUSINESS OUTCOME ${r.outcome.code}`
        : `FAILURE ${r.error.code}`;
  lines.push(
    `${head} — ${r.capability.name}@${r.capability.version} on ${r.tenant} (${r.durationMs}ms, run ${r.runId})`,
  );
  if (r.status === "success") lines.push(`  outputs: ${JSON.stringify(r.outputs)}`);
  if (r.status === "business_outcome")
    lines.push(
      `  ${r.outcome.message}${r.outcome.data ? ` ${JSON.stringify(r.outcome.data)}` : ""}`,
    );
  if (r.status === "failure") {
    lines.push(`  ${r.error.message}`);
    if (r.error.stepId)
      lines.push(`  at step ${r.error.stepIndex! + 1} "${r.error.stepName}" (${r.error.stepId})`);
    if (r.error.expected) lines.push(`  expected: ${r.error.expected}`);
    if (r.error.observed) lines.push(`  observed: ${r.error.observed}`);
    if (r.error.evidence.length) lines.push(`  evidence: ${r.error.evidence.join(", ")}`);
  }
  lines.push(
    `  steps: ${r.steps.map((s) => `${s.stepId}:${s.status}${s.resolution ? `[${s.resolution.strategy}/t${s.resolution.tier}]` : ""}`).join(" ")}`,
  );
  if (r.recoveries.length)
    lines.push(
      `  conditions: ${r.recoveries.map((c) => `${c.conditionId}(${c.class}→${c.handled})`).join(", ")}`,
    );
  if (r.interventions.length)
    lines.push(
      `  interventions: ${r.interventions.map((i) => `${i.type}→${i.resolution ?? "?"} (${i.humanActions} human actions, ${i.controlTransfers} transfers)`).join(", ")}`,
    );
  if (r.drift.warnings.length) lines.push(`  drift: ${r.drift.warnings.join(" | ")}`);
  lines.push(`  evidence: ${r.evidence.dir}`);
  return lines.join("\n");
}

export function formatDiscovery(d: DiscoveryResult): string {
  const lines: string[] = [];
  lines.push(
    `${d.status === "success" ? "DISCOVERED" : `DISCOVERY FAILED ${d.error?.code ?? ""}`} — "${d.goal}" on ${d.tenant} (${d.actions} actions, ${d.llm.calls} model calls, ${d.durationMs}ms)`,
  );
  if (d.capability)
    lines.push(
      `  capability: ${d.capability.name}@${d.capability.version} (${d.capability.steps.length} steps, risk=${d.capability.policy.riskClass}) → ${d.artifactPath ?? "(not persisted)"}`,
    );
  if (d.error) lines.push(`  ${d.error.message}`);
  if (d.llm.calls)
    lines.push(
      `  tokens: in=${d.llm.inputTokens} out=${d.llm.outputTokens} cache_read=${d.llm.cacheReadTokens} cache_write=${d.llm.cacheWriteTokens} (${d.llm.model})`,
    );
  if (d.interventions.length)
    lines.push(
      `  interventions: ${d.interventions.map((i) => `${i.type}→${i.resolution ?? "?"}`).join(", ")}`,
    );
  lines.push(`  evidence: ${d.evidence.dir}`);
  return lines.join("\n");
}

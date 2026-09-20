/**
 * Self-contained HTML report for one run directory: what happened, in order, with the
 * screenshots next to the decisions. Images are referenced relatively, so the report opens
 * from the evidence folder without inlining megabytes.
 */
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "./store.js";
import type { RunEvent } from "../core/events.js";

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface ResultLike {
  runId?: string;
  kind?: string;
  status?: string;
  capability?: { name: string; version: string };
  goal?: string;
  tenant?: string;
  durationMs?: number;
  outputs?: Record<string, unknown>;
  outcome?: { code: string; message: string };
  error?: { code: string; message: string; stepId?: string; expected?: string; observed?: string; evidence?: string[] };
  steps?: Array<{ stepId: string; index: number; kind: string; name: string; status: string; attempts: number; resolution?: { strategy: string; tier: number; ms: number }; screenshot?: string; dialog?: { message: string; response: string }; extracted?: { output: string; raw: string }; recoveries?: Array<{ conditionId: string; class: string; handled: string }>; overridden?: string[]; proposedOverride?: { resolvedVia: string }; error?: { code: string; message: string } }>;
  recoveries?: Array<{ conditionId: string; class: string; handled: string; stepId?: string }>;
  interventions?: Array<{ id: string; type: string; reason: string; resolution?: string; operator?: string; humanActions: number; controlTransfers: number; note?: string }>;
  assists?: Array<{ stepId: string; reason: string; decision: string; note?: string; proposed?: { role: string; name: string; text: string } | null }>;
  proposedConditions?: Array<{ id: string; class: string; description: string }>;
  drift?: { tierHistogram: Record<string, number>; warnings: string[] };
  policy?: { decisions: number; denied: number; confirmations: number };
  integrity?: { hash: string; effectiveStatus: string; approvedHashMatches: boolean | null };
  ledger?: Array<{ key: string; stepId: string; status: string }>;
  llm?: { calls: number; inputTokens: number; outputTokens: number; model: string };
  actions?: number;
  evidence?: { trace?: string };
}

export function renderRunReport(dir: string): string {
  const result = readJson<ResultLike>(path.join(dir, "result.json")) ?? {};
  const events: RunEvent[] = fs.existsSync(path.join(dir, "events.jsonl")) ? readEvents(path.join(dir, "events.jsonl")) : [];
  const title = `${result.kind ?? "run"} ${result.capability ? `${result.capability.name}@${result.capability.version}` : ""} — ${(result.status ?? "unknown").toUpperCase()}`;
  const badge = (s: string) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

  const summary: string[] = [];
  summary.push(`<div class="card"><div class="k">Status</div><div class="v">${badge(result.status ?? "unknown")}</div></div>`);
  if (result.tenant) summary.push(`<div class="card"><div class="k">Tenant</div><div class="v">${esc(result.tenant)}</div></div>`);
  if (result.durationMs !== undefined) summary.push(`<div class="card"><div class="k">Duration</div><div class="v">${(result.durationMs / 1000).toFixed(1)} s</div></div>`);
  if (result.policy) summary.push(`<div class="card"><div class="k">Policy decisions</div><div class="v">${result.policy.decisions} <span class="muted">(${result.policy.denied} denied, ${result.policy.confirmations} confirmations)</span></div></div>`);
  if (result.llm) summary.push(`<div class="card"><div class="k">Model</div><div class="v">${esc(result.llm.model)} <span class="muted">${result.llm.calls} calls, ${result.llm.inputTokens}/${result.llm.outputTokens} tokens</span></div></div>`);
  if (result.integrity) summary.push(`<div class="card"><div class="k">Artifact integrity</div><div class="v"><code>${esc(result.integrity.hash.slice(0, 16))}…</code> <span class="muted">effective ${esc(result.integrity.effectiveStatus)}</span></div></div>`);

  const headline =
    result.status === "success"
      ? `<p class="headline ok">Outputs: <code>${esc(JSON.stringify(result.outputs))}</code></p>`
      : result.status === "business_outcome"
        ? `<p class="headline warn"><strong>${esc(result.outcome?.code)}</strong> — ${esc(result.outcome?.message)}</p>`
        : result.error
          ? `<p class="headline bad"><strong>${esc(result.error.code)}</strong>${result.error.stepId ? ` at step <code>${esc(result.error.stepId)}</code>` : ""} — ${esc(result.error.message)}${result.error.expected ? `<br><span class="muted">expected:</span> ${esc(result.error.expected)}` : ""}${result.error.observed ? `<br><span class="muted">observed:</span> ${esc(result.error.observed)}` : ""}</p>`
          : "";

  let steps = "";
  if (result.steps?.length) {
    steps = `<h2>Steps</h2><div class="steps">${result.steps
      .map(
        (s) => `<div class="step">
        <div class="step-head">${badge(s.status)} <strong>${s.index + 1}. ${esc(s.name)}</strong> <span class="muted">[${esc(s.kind)}${s.attempts > 1 ? `, ${s.attempts} attempts` : ""}]</span></div>
        <div class="step-meta">${s.resolution ? `resolved via <code>${esc(s.resolution.strategy)}</code> tier ${s.resolution.tier} (${s.resolution.ms} ms)` : ""}${s.overridden?.length ? ` · tenant override: ${esc(s.overridden.join(", "))}` : ""}${s.proposedOverride ? ` · <em>override proposed (via ${esc(s.proposedOverride.resolvedVia)})</em>` : ""}${s.dialog ? ` · dialog "${esc(s.dialog.message)}" → ${esc(s.dialog.response)}` : ""}${s.extracted ? ` · extracted <code>${esc(s.extracted.output)}</code> = "${esc(s.extracted.raw)}"` : ""}${s.recoveries?.length ? ` · conditions: ${s.recoveries.map((r) => `${esc(r.conditionId)} (${esc(r.class)} → ${esc(r.handled)})`).join(", ")}` : ""}${s.error ? ` · <span class="bad">${esc(s.error.code)}: ${esc(s.error.message)}</span>` : ""}</div>
        ${s.screenshot ? `<a href="${esc(s.screenshot)}"><img loading="lazy" src="${esc(s.screenshot)}" alt="after step ${s.index + 1}"></a>` : ""}
      </div>`,
      )
      .join("")}</div>`;
  } else {
    // Discovery: one card per observation with the marked screenshot the model saw.
    const observes = events.filter((e) => e.type === "agent.observe");
    if (observes.length) {
      steps = `<h2>Turns</h2><div class="steps">${observes
        .map((o) => {
          const turn = o.data?.turn as number;
          const decide = events.find((e) => e.type === "agent.decide" && e.data?.turn === turn);
          const acts = events.filter((e) => e.type === "agent.act" && e.seq > o.seq && e.seq < (observes.find((x) => (x.data?.turn as number) === turn + 1)?.seq ?? Infinity));
          return `<div class="step"><div class="step-head"><strong>Turn ${turn}</strong> <span class="muted">${esc(o.data?.url)}${o.data?.landmark ? ` · "${esc(o.data.landmark)}"` : ""}</span></div>
          <div class="step-meta">${decide ? `decided: ${esc(decide.msg.replace(/^Turn \d+: /, ""))}` : ""}${acts.map((a) => `<br>→ ${esc(a.msg)}`).join("")}</div>
          ${o.data?.screenshot ? `<a href="${esc(o.data.screenshot)}"><img loading="lazy" src="${esc(o.data.screenshot)}" alt="turn ${turn}"></a>` : ""}</div>`;
        })
        .join("")}</div>`;
    }
  }

  const list = (title: string, rows: string[]) => (rows.length ? `<h2>${title}</h2><ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>` : "");
  const interventions = list(
    "Interventions",
    (result.interventions ?? []).map((i) => `${badge(i.type)} ${esc(i.reason)} → <strong>${esc(i.resolution ?? "?")}</strong>${i.operator ? ` by ${esc(i.operator)}` : ""} · ${i.humanActions} human action(s), ${i.controlTransfers} control transfer(s)${i.note ? ` · <em>${esc(i.note)}</em>` : ""}${i.id ? ` · <a href="interventions/${esc(i.id)}.json">record</a>` : ""}`),
  );
  const humanShots = fs.existsSync(path.join(dir, "interventions"))
    ? fs
        .readdirSync(path.join(dir, "interventions"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => fs.readdirSync(path.join(dir, "interventions", d.name)).filter((f) => f.endsWith(".png")).map((f) => `interventions/${d.name}/${f}`))
    : [];
  const humanGallery = humanShots.length ? `<div class="gallery">${humanShots.map((f) => `<a href="${esc(f)}"><img loading="lazy" src="${esc(f)}" alt="${esc(f)}"></a>`).join("")}</div>` : "";
  const assists = list("Model-assisted recoveries", (result.assists ?? []).map((a) => `step <code>${esc(a.stepId)}</code>: ${esc(a.reason)} → <strong>${esc(a.decision)}</strong>${a.proposed ? ` (${esc(a.proposed.role)} "${esc(a.proposed.name || a.proposed.text)}")` : ""}${a.note ? ` · ${esc(a.note)}` : ""}`));
  const proposed = list("Conditions proposed from human actions", (result.proposedConditions ?? []).map((c) => `<code>${esc(c.id)}</code> (${esc(c.class)}): ${esc(c.description)}`));
  const conditions = list("Conditions", (result.recoveries ?? []).map((r) => `<code>${esc(r.conditionId)}</code> ${esc(r.class)} → ${esc(r.handled)}${r.stepId ? ` at ${esc(r.stepId)}` : ""}`));
  const drift = result.drift?.warnings?.length ? `<h2>Drift</h2><ul>${result.drift.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
  const ledger = list("Idempotency ledger", (result.ledger ?? []).map((l) => `key <code>${esc(l.key)}</code> step <code>${esc(l.stepId)}</code>: ${esc(l.status)}`));
  const failureFiles = result.error?.evidence?.length ? `<h2>Failure evidence</h2><ul>${result.error.evidence.map((f) => `<li><a href="${esc(f)}">${esc(f)}</a></li>`).join("")}${result.evidence?.trace ? `<li><a href="${esc(result.evidence.trace)}">${esc(result.evidence.trace)}</a> (open with <code>npx playwright show-trace</code>)</li>` : ""}</ul>` : "";

  const timeline = `<h2>Event timeline</h2><details><summary>${events.length} events</summary><table class="events">${events
    .map((e) => `<tr><td class="muted">${esc(e.ts.slice(11, 23))}</td><td><code>${esc(e.type)}</code></td><td>${esc(e.msg)}</td></tr>`)
    .join("")}</table></details>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:0;padding:20px 28px;color:#1b1f24;background:#f6f7f9}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px}
.muted{color:#57606a} code{background:#eef1f4;padding:1px 4px;border-radius:3px;font-size:12px}
.badge{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;background:#e7ecf1;text-transform:uppercase}
.badge.success,.badge.ok{background:#d3f9d8} .badge.business_outcome,.badge.recovered,.badge.approval{background:#fff3bf} .badge.failure,.badge.failed{background:#ffe3e3} .badge.skipped{background:#e7ecf1}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0} .card{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:8px 12px;min-width:140px} .card .k{font-size:11px;color:#57606a;text-transform:uppercase} .card .v{font-size:14px}
.headline{background:#fff;border-left:4px solid #adb5bd;padding:8px 12px;border-radius:4px} .headline.ok{border-color:#2b8a3e} .headline.warn{border-color:#e67700} .headline.bad{border-color:#c92a2a} .bad{color:#c92a2a}
.steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px} .step{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:10px} .step img,.gallery img{width:100%;border:1px solid #d0d7de;border-radius:4px;margin-top:8px} .step-meta{font-size:12px;color:#57606a;margin-top:4px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
table.events{border-collapse:collapse;font-size:12px;background:#fff} table.events td{border-bottom:1px solid #eef1f4;padding:3px 8px;vertical-align:top}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="muted">run ${esc(result.runId ?? path.basename(dir))}${result.goal ? ` · goal: "${esc(result.goal)}"` : ""} · directory <code>${esc(path.basename(dir))}</code></div>
<div class="cards">${summary.join("")}</div>
${headline}
${steps}
${conditions}${interventions}${humanGallery}${assists}${proposed}${drift}${ledger}${failureFiles}
${timeline}
</body></html>`;
}

export function writeRunReport(dir: string): string {
  const file = path.join(dir, "report.html");
  fs.writeFileSync(file, renderRunReport(dir));
  return file;
}

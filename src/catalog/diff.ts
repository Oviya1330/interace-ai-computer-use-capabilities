/** Reviewer-oriented diff between two artifact versions. */
import type { Capability, Step } from "../core/schema.js";

function stepSig(s: Step): string {
  const t = "target" in s ? s.target.strategies.map((x) => x.kind).join(">") : "";
  const v = "value" in s ? JSON.stringify(s.value) : "";
  return `${s.kind}|${s.name}|${t}|${v}|${s.risk}|${JSON.stringify(s.expect)}|${JSON.stringify(s.precondition)}|${JSON.stringify(s.dialog ?? null)}`;
}

export function diffCapabilities(a: Capability, b: Capability): string[] {
  const out: string[] = [];
  const add = (l: string) => out.push(l);
  if (a.name !== b.name) add(`name: ${a.name} → ${b.name}`);
  add(`version: ${a.version} → ${b.version}; status: ${a.status} → ${b.status}`);
  if (a.title !== b.title) add(`title changed`);
  if (a.description !== b.description) add(`description changed`);
  for (const k of new Set([...Object.keys(a.inputs), ...Object.keys(b.inputs)])) {
    const x = a.inputs[k];
    const y = b.inputs[k];
    if (!x) add(`input +${k} (${y!.type}, ${y!.sensitivity})`);
    else if (!y) add(`input -${k}`);
    else if (JSON.stringify(x) !== JSON.stringify(y))
      add(`input ~${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  }
  for (const k of new Set([...Object.keys(a.outputs), ...Object.keys(b.outputs)])) {
    const x = a.outputs[k];
    const y = b.outputs[k];
    if (!x) add(`output +${k}`);
    else if (!y) add(`output -${k}`);
    else if (JSON.stringify(x) !== JSON.stringify(y)) add(`output ~${k}`);
  }
  if (JSON.stringify(a.policy) !== JSON.stringify(b.policy))
    add(`policy: ${JSON.stringify(a.policy)} → ${JSON.stringify(b.policy)}`);
  const as = new Map(a.steps.map((s) => [s.id, s]));
  const bs = new Map(b.steps.map((s) => [s.id, s]));
  for (const [id, s] of bs) if (!as.has(id)) add(`step +${id} (${s.kind}: ${s.name})`);
  for (const [id, s] of as) {
    const t = bs.get(id);
    if (!t) add(`step -${id} (${s.kind}: ${s.name})`);
    else if (stepSig(s) !== stepSig(t)) {
      const what: string[] = [];
      if (s.name !== t.name) what.push("name");
      if (
        "target" in s &&
        "target" in t &&
        JSON.stringify(s.target.strategies) !== JSON.stringify(t.target.strategies)
      )
        what.push(
          `strategies ${s.target.strategies.map((x) => x.kind).join(">")} → ${t.target.strategies.map((x) => x.kind).join(">")}`,
        );
      if (JSON.stringify(s.expect) !== JSON.stringify(t.expect)) what.push("post-conditions");
      if (JSON.stringify(s.precondition) !== JSON.stringify(t.precondition))
        what.push("pre-conditions");
      if (s.risk !== t.risk) what.push(`risk ${s.risk} → ${t.risk}`);
      add(`step ~${id}: ${what.join(", ") || "changed"}`);
    }
  }
  if (a.steps.map((s) => s.id).join(",") !== b.steps.map((s) => s.id).join(","))
    add(
      `step order: ${a.steps.map((s) => s.id).join(" ")} → ${b.steps.map((s) => s.id).join(" ")}`,
    );
  if (JSON.stringify(a.checkpoint) !== JSON.stringify(b.checkpoint)) add("checkpoint changed");
  const ac = new Map(a.conditions.map((c) => [c.id, c]));
  const bc = new Map(b.conditions.map((c) => [c.id, c]));
  for (const [id, c] of bc) if (!ac.has(id)) add(`condition +${id} (${c.class}, ${c.origin})`);
  for (const [id] of ac) if (!bc.has(id)) add(`condition -${id}`);
  for (const [id, c] of bc)
    if (ac.has(id) && JSON.stringify(ac.get(id)) !== JSON.stringify(c)) add(`condition ~${id}`);
  for (const t of new Set([...Object.keys(a.overrides), ...Object.keys(b.overrides)])) {
    const x = a.overrides[t];
    const y = b.overrides[t];
    if (!x)
      add(
        `override +${t}: steps ${Object.keys(y!.steps).join(", ") || "-"}, conditions ${y!.conditions.length}`,
      );
    else if (!y) add(`override -${t}`);
    else if (JSON.stringify(x) !== JSON.stringify(y))
      add(`override ~${t}: steps ${Object.keys(y.steps).join(", ") || "-"}`);
  }
  if (a.integrity?.hash !== b.integrity?.hash)
    add(
      `integrity: ${a.integrity?.hash.slice(0, 12) ?? "-"} → ${b.integrity?.hash.slice(0, 12) ?? "-"}`,
    );
  return out;
}

#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import { capabilityJsonSchema, Capability, type TargetStrategyKind } from "../core/schema.js";
import {
  CapabilityStore,
  loadDotEnv,
  loadPolicy,
  loadProfile,
  loadTenant,
  listTenants,
  projectRoot,
} from "../catalog/store.js";
import { Redactor } from "../policy/redact.js";
import { capabilityToTool } from "../catalog/tools.js";
import { checkIntegrity } from "../catalog/integrity.js";
import { diffCapabilities } from "../catalog/diff.js";
import { generatePlaywrightScript } from "../catalog/codegen.js";
import { writeRunReport } from "../evidence/report.js";
import { AuditLog } from "../hitl/audit.js";
import { startCapabilityServer } from "../catalog/server.js";
import { errorMessage } from "../core/errors.js";
import {
  approveCapability,
  discoverCommand,
  formatDiscovery,
  formatResult,
  promoteConditions,
  promoteOverrides,
  replayCommand,
  type ChaosSpec,
} from "./commands.js";

function parseKV(value: string, previous: Record<string, string> = {}): Record<string, string> {
  const i = value.indexOf("=");
  if (i <= 0) throw new InvalidArgumentError(`expected name=value, got "${value}"`);
  return { ...previous, [value.slice(0, i)]: value.slice(i + 1) };
}

function parseProbe(
  value: string,
  previous: Array<{ name: string; inputs: Record<string, string> }> = [],
) {
  const i = value.indexOf(":");
  if (i <= 0) throw new InvalidArgumentError(`expected name:k=v[,k=v], got "${value}"`);
  const inputs: Record<string, string> = {};
  for (const kv of value.slice(i + 1).split(",")) Object.assign(inputs, parseKV(kv));
  return [...previous, { name: value.slice(0, i), inputs }];
}

function parseChaos(value: string): ChaosSpec {
  const [scenario, count, pathPattern] = value.split(":");
  return {
    scenario: scenario!,
    count: count ? Number(count) : 1,
    ...(pathPattern ? { pathPattern } : {}),
  };
}

const program = new Command();
program
  .name("cua")
  .description(
    "Computer-use automation: discover once with an LLM, replay deterministically, hand off to a human when stuck.",
  );

program
  .command("discover")
  .description("Run an LLM-driven discovery of a goal and record it as a capability artifact")
  .requiredOption("--goal <text>", "natural-language goal")
  .option("--tenant <id>", "tenant binding id", "summit")
  .option("--input <name=value>", "input parameter (repeatable)", parseKV, {})
  .option(
    "--sensitive <name>",
    "mark an input as PII (repeatable)",
    (v: string, p: string[] = []) => [...p, v],
    [],
  )
  .option("--name <capability.name>", "capability name to use instead of the model's proposal")
  .option(
    "--probe <name:k=v,...>",
    "after success, replay with these inputs and learn the resulting condition (repeatable)",
    parseProbe,
    [],
  )
  .option("--decider <spec>", "llm | scripted:<flow>", "llm")
  .option("--headed", "show the browser", false)
  .option("--no-console", "do not start the operator console (escalations then fail fast)")
  .option("--evidence-dir <dir>", "evidence root", "runs")
  .option("--label <name>", "evidence folder name")
  .option("--max-steps <n>", "action budget", (v: string) => Number(v))
  .option("--model <id>", "model id (default: CUA_MODEL or claude-opus-5)")
  .option("--effort <level>", "low|medium|high|xhigh|max (default: CUA_EFFORT or high)")
  .option("--no-verify", "skip the model-free verification replay after recording")
  .option(
    "--verify-mutating",
    "verify mutating/irreversible capabilities too (they post for real)",
    false,
  )
  .option("--json", "print the result as JSON", false)
  .action(async (o) => {
    loadDotEnv();
    const out = await discoverCommand({
      goal: o.goal,
      tenant: o.tenant,
      inputs: o.input,
      sensitive: o.sensitive,
      name: o.name,
      probes: o.probe,
      decider: o.decider,
      headed: o.headed,
      console: o.console,
      evidenceRoot: o.evidenceDir,
      label: o.label,
      maxSteps: o.maxSteps,
      model: o.model,
      effort: o.effort,
      verify: o.verify,
      verifyMutating: o.verifyMutating,
    });
    if (o.json) {
      console.log(
        JSON.stringify(
          {
            ...out.result,
            capability: out.capability
              ? {
                  name: out.capability.name,
                  version: out.capability.version,
                  verification: out.capability.provenance.verification,
                }
              : undefined,
            probes: out.probes.map((p) => ({
              name: p.name,
              status: p.replay.status,
              note: p.note,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatDiscovery(out.result));
      for (const p of out.probes) console.log(`  probe ${p.name}: ${p.replay.status} — ${p.note}`);
      const v = out.capability?.provenance.verification;
      if (v) console.log(`  verification replay: ${v.status}${v.reason ? ` (${v.reason})` : ""}`);
    }
    process.exitCode = out.result.status === "success" ? 0 : 1;
  });

program
  .command("replay")
  .description("Replay a capability deterministically (no LLM in the loop) with input parameters")
  .argument("<capability>", "name, name@version, or artifact file path")
  .option("--tenant <id>", "tenant binding id", "summit")
  .option("--input <name=value>", "input parameter (repeatable)", parseKV, {})
  .option(
    "--approve <reason>",
    "explicit invocation approval for risky steps (recorded in evidence and the audit log)",
  )
  .option(
    "--approved-by <who>",
    "who gave the invocation approval (four-eyes: must differ from --requested-by for irreversible steps)",
  )
  .option("--requested-by <who>", "who is asking (agent id or user)")
  .option(
    "--idempotency-key <key>",
    "makes irreversible steps idempotent across invocations (a repeat returns DUPLICATE_INVOCATION)",
  )
  .option(
    "--locators <kinds>",
    "locator strategies for action steps, as an allow list AND preference order, e.g. visual,text or role,label,text",
    (v: string) => v.split(",") as TargetStrategyKind[],
  )
  .option(
    "--assist <decider>",
    "bounded model-assisted recovery when a control cannot be found: llm or scripted:<flow>",
  )
  .option(
    "--chaos <scenario[:count[:pathPattern]]>",
    "arm a runtime fault on the mock app before replaying",
    parseChaos,
  )
  .option("--times <n>", "replay N times and report stability", (v: string) => Number(v), 1)
  .option("--headed", "show the browser", false)
  .option(
    "--no-console",
    "do not start the operator console (hard failures fail instead of escalating)",
  )
  .option("--evidence-dir <dir>", "evidence root", "runs")
  .option("--label <name>", "evidence folder name")
  .option("--json", "print the result as JSON", false)
  .action(async (cap: string, o) => {
    loadDotEnv();
    const results = await replayCommand({
      capability: cap,
      tenant: o.tenant,
      inputs: o.input,
      approve: o.approve,
      approvedBy: o.approvedBy,
      requestedBy: o.requestedBy,
      idempotencyKey: o.idempotencyKey,
      locators: o.locators,
      assist: o.assist,
      chaos: o.chaos,
      times: o.times,
      headed: o.headed,
      console: o.console,
      evidenceRoot: o.evidenceDir,
      label: o.label,
    });
    if (o.json) console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    else {
      for (const r of results) console.log(formatResult(r));
      if (results.length > 1) {
        const ok = results.filter((r) => r.status === "success").length;
        const bo = results.filter((r) => r.status === "business_outcome").length;
        const mean = Math.round(results.reduce((a, r) => a + r.durationMs, 0) / results.length);
        console.log(
          `STABILITY: ${ok}/${results.length} success, ${bo} business outcomes, ${results.length - ok - bo} failures; mean ${mean}ms`,
        );
      }
    }
    const last = results[results.length - 1]!;
    process.exitCode = last.status === "success" ? 0 : last.status === "business_outcome" ? 2 : 1;
  });

program
  .command("list")
  .description("List capabilities in the catalog")
  .action(() => {
    const store = new CapabilityStore();
    for (const c of store.list()) {
      const cap = store.load(`${c.name}@${c.version}`);
      const integ = checkIntegrity(cap);
      console.log(
        `${c.name}@${c.version}  [${integ.effectiveStatus}${integ.effectiveStatus !== c.status ? `, stored ${c.status}` : ""}] ${c.riskClass.padEnd(12)} in(${c.inputs.join(", ")}) -> out(${c.outputs.join(", ")})  ${c.title}${cap.provenance.verification ? `  verify:${cap.provenance.verification.status}` : ""}`,
      );
    }
  });

program
  .command("show")
  .description("Print a capability (reviewer view)")
  .argument("<capability>")
  .option("--json", "full JSON", false)
  .action((ref: string, o) => {
    const cap = new CapabilityStore().load(ref);
    if (o.json) return console.log(JSON.stringify(cap, null, 2));
    const integ = checkIntegrity(cap);
    console.log(
      `${cap.name}@${cap.version} [${cap.status}${integ.effectiveStatus !== cap.status ? ` → effective ${integ.effectiveStatus}` : ""}] — ${cap.title}`,
    );
    console.log(cap.description);
    console.log(`goal: ${cap.goal}`);
    console.log(
      `app: ${cap.app.family} (${cap.app.surface}, profile ${cap.app.profile}); recorded on ${cap.provenance.tenant} by ${cap.provenance.recordedBy.kind}${cap.provenance.recordedBy.model ? `/${cap.provenance.recordedBy.model}` : ""} at ${cap.provenance.recordedAt}`,
    );
    if (cap.provenance.verification)
      console.log(
        `verification: ${cap.provenance.verification.status}${cap.provenance.verification.reason ? ` (${cap.provenance.verification.reason})` : ""}`,
      );
    if (cap.provenance.derivedFrom)
      console.log(
        `derived from: ${cap.provenance.derivedFrom.version} — ${cap.provenance.derivedFrom.reason}`,
      );
    console.log(
      `integrity: sha256 ${integ.hash.slice(0, 16)}…${integ.problems.length ? ` PROBLEMS: ${integ.problems.join("; ")}` : " ok"}`,
    );
    console.log(
      `policy: risk=${cap.policy.riskClass} sideEffects=${cap.policy.sideEffects} requiresApproval=${cap.policy.requiresApproval}`,
    );
    console.log("inputs:");
    for (const [n, s] of Object.entries(cap.inputs))
      console.log(
        `  ${n}: ${s.type}${s.pattern ? ` /${s.pattern}/` : ""} [${s.sensitivity}] — ${s.description}${s.example ? ` (e.g. ${s.example})` : ""}`,
      );
    console.log("outputs:");
    for (const [n, s] of Object.entries(cap.outputs))
      console.log(`  ${n}: ${s.type} [${s.sensitivity}] — ${s.description}`);
    console.log("steps:");
    cap.steps.forEach((s, i) =>
      console.log(
        `  ${i + 1}. [${s.kind}${s.risk !== "safe" ? `, ${s.risk}` : ""}] ${s.name}${"target" in s ? `  strategies: ${s.target.strategies.map((t) => t.kind).join(" > ")}` : ""}${s.precondition.length ? `  pre: ${s.precondition.length}` : ""}${s.expect.length ? `  post: ${s.expect.length}` : ""}${s.dialog ? "  dialog: " + s.dialog.response : ""}`,
      ),
    );
    console.log(`checkpoint: ${cap.checkpoint.description}`);
    console.log("conditions:");
    for (const c of cap.conditions)
      console.log(`  ${c.id} (${c.class}, ${c.origin}): ${c.description}`);
    for (const [t, ov] of Object.entries(cap.overrides))
      console.log(
        `overrides for ${t}: steps ${Object.keys(ov.steps).join(", ") || "-"}, conditions ${ov.conditions.length}`,
      );
    console.log(`stats: ${JSON.stringify(cap.stats)}`);
  });

program
  .command("validate")
  .description(
    "Validate artifact files against the schema, the integrity hash and the no-secrets rule",
  )
  .argument("<files...>")
  .action((files: string[]) => {
    let bad = 0;
    for (const f of files) {
      try {
        const cap = Capability.parse(JSON.parse(fs.readFileSync(f, "utf8")));
        const integ = checkIntegrity(cap);
        if (integ.problems.length) {
          bad++;
          console.log(`WARN  ${f}: ${integ.problems.join("; ")}`);
        } else console.log(`ok    ${f}  (${cap.status}, sha256 ${integ.hash.slice(0, 12)}…)`);
      } catch (e) {
        bad++;
        console.log(`FAIL  ${f}: ${errorMessage(e).split("\n")[0]}`);
      }
    }
    process.exitCode = bad ? 1 : 0;
  });

program
  .command("approve")
  .description(
    "Approve a capability for unattended replay (the approval is bound to the artifact's content hash)",
  )
  .argument("<capability>")
  .requiredOption("--by <name>", "approver")
  .option("--notes <text>")
  .action((ref: string, o) => {
    const store = new CapabilityStore();
    const cap = store.load(ref);
    if (cap.provenance.verification?.status === "failed")
      throw new Error(
        `refusing to approve ${cap.name}@${cap.version}: its verification replay failed (${cap.provenance.verification.reason ?? "see evidence"})`,
      );
    const approved = approveCapability(cap, o.by, o.notes);
    const file = store.save(approved, new Redactor());
    console.log(
      `approved ${cap.name}@${cap.version} (bound to content hash ${approved.review!.approvedHash!.slice(0, 12)}…) → ${file}`,
    );
  });

program
  .command("promote")
  .description(
    "Turn what a replay run learned into artifact changes: fallback resolutions → tenant overrides, or (--conditions) operator actions → conditions. Produces a new draft version.",
  )
  .argument("<capability>")
  .requiredOption(
    "--run <evidenceDir>",
    "evidence directory of the replay run (contains result.json)",
  )
  .option("--tenant <id>", "tenant the run was executed on (for overrides)", "summit")
  .option(
    "--conditions",
    "promote the conditions proposed from the operator's actions instead of locator overrides",
    false,
  )
  .option("--by <name>", "reviewer", process.env.USER ?? "reviewer")
  .action((ref: string, o) => {
    const store = new CapabilityStore();
    const cap = store.load(ref);
    const result = JSON.parse(fs.readFileSync(`${o.run}/result.json`, "utf8"));
    const { capability, promoted } = o.conditions
      ? promoteConditions(cap, result.proposedConditions ?? [])
      : promoteOverrides(cap, o.tenant, result);
    if (promoted.length === 0)
      return console.log(
        o.conditions
          ? "no proposed conditions in that run; nothing to promote"
          : "no fallback resolutions in that run; nothing to promote",
      );
    for (const id of promoted) {
      if (o.conditions) {
        const c = capability.conditions.find((x) => x.id === id)!;
        console.log(`condition ${id} (${c.class}, ${c.origin}): ${c.description}`);
      } else {
        const t = capability.overrides[o.tenant]!.steps[id]!.target!;
        console.log(
          `override ${o.tenant}/${id}: strategies now ${t.strategies.map((s) => s.kind).join(" > ")}`,
        );
      }
    }
    capability.review = {
      ...capability.review,
      notes: `${capability.review?.notes ?? ""} by ${o.by}`,
    };
    const file = store.save(capability, new Redactor());
    console.log(`saved ${capability.name}@${capability.version} (draft, needs approval) → ${file}`);
  });

program
  .command("report")
  .description(
    "Render a self-contained HTML report (steps, screenshots, conditions, interventions, timeline) for run directories",
  )
  .argument("<runDirs...>")
  .action((dirs: string[]) => {
    for (const d of dirs) console.log(writeRunReport(d));
  });

program
  .command("codegen")
  .description(
    "Emit a standalone Playwright script from a capability (stretch goal: code generation)",
  )
  .argument("<capability>")
  .option("--tenant <id>", "tenant binding id", "summit")
  .option(
    "--input <name=value>",
    "inputs the script takes (repeatable); values are passed at run time, never baked in",
    parseKV,
    {},
  )
  .option("--out <file>", "write to this file instead of stdout")
  .action((ref: string, o) => {
    const cap = new CapabilityStore().load(ref);
    const tenant = loadTenant(o.tenant);
    const profile = loadProfile(tenant.profile);
    const code = generatePlaywrightScript(cap, profile, tenant, o.input);
    if (o.out) {
      fs.writeFileSync(o.out, code);
      console.log(`wrote ${o.out} (run with: npx tsx ${o.out} '${JSON.stringify(o.input)}')`);
    } else process.stdout.write(code);
  });

program
  .command("diff")
  .description("Reviewer diff between two artifact versions")
  .argument("<a>")
  .argument("<b>")
  .action((a: string, b: string) => {
    const store = new CapabilityStore();
    for (const line of diffCapabilities(store.load(a), store.load(b))) console.log(line);
  });

program
  .command("audit")
  .description("Verify or tail the hash-chained audit log (state/audit.jsonl)")
  .argument("[action]", "verify | tail", "verify")
  .option("--file <path>", "audit log file", `${projectRoot()}/state/audit.jsonl`)
  .action((action: string, o) => {
    if (action === "tail") {
      for (const e of AuditLog.read(o.file).slice(-20))
        console.log(`${e.seq}\t${e.at}\t${e.type}\t${e.actor}\t${JSON.stringify(e.data)}`);
      return;
    }
    const v = AuditLog.verify(o.file);
    console.log(
      v.ok
        ? `audit chain intact: ${v.entries} entries`
        : `AUDIT CHAIN BROKEN at entry ${v.brokenAt} (${v.entries} entries)`,
    );
    process.exitCode = v.ok ? 0 : 1;
  });

program
  .command("doctor")
  .description("Check the local setup: node, browser, config, credentials, target app")
  .action(async () => {
    loadDotEnv();
    const rows: Array<[string, boolean, string, boolean]> = []; // name, ok, detail, blocking
    const major = Number(process.versions.node.split(".")[0]);
    rows.push(["node >= 20", major >= 20, process.versions.node, true]);
    try {
      const { chromium } = await import("playwright");
      const exe = chromium.executablePath();
      rows.push([
        "playwright chromium",
        fs.existsSync(exe),
        fs.existsSync(exe) ? exe : `${exe} missing (npx playwright install chromium)`,
        true,
      ]);
    } catch (e) {
      rows.push(["playwright chromium", false, errorMessage(e), true]);
    }
    try {
      const policy = loadPolicy();
      rows.push([
        "policy.yaml",
        true,
        `${policy.allow.origins.length} allowed origin(s), replay mode ${policy.modes.replay}, four-eyes ${policy.risk.fourEyes}, assist ${policy.assist.enabled ? "on" : "off"}`,
        true,
      ]);
    } catch (e) {
      rows.push(["policy.yaml", false, errorMessage(e), true]);
    }
    const tenants = listTenants();
    rows.push(["tenants", tenants.length > 0, tenants.map((t) => t.id).join(", ") || "none", true]);
    for (const t of tenants) {
      try {
        loadProfile(t.profile);
        rows.push([`profile ${t.profile}`, true, "ok", true]);
      } catch (e) {
        rows.push([`profile ${t.profile}`, false, errorMessage(e), true]);
      }
      for (const [ref, src] of Object.entries(t.secrets)) {
        const v = src.startsWith("env:") ? process.env[src.slice(4)] : undefined;
        rows.push([
          `secret ${t.id}/${ref}`,
          !!v,
          v
            ? `${src} is set`
            : `${src} is not set (set it in .env; the mock app accepts its documented defaults)`,
          false,
        ]);
      }
      const ok = await fetch(`${new URL(t.baseUrl).origin}/__health`)
        .then((r) => r.ok)
        .catch(() => false);
      rows.push([
        `app ${t.id}`,
        ok,
        ok ? `${t.baseUrl} reachable` : `${t.baseUrl} not reachable (npm run app)`,
        false,
      ]);
    }
    rows.push([
      "ANTHROPIC_API_KEY",
      !!process.env.ANTHROPIC_API_KEY,
      process.env.ANTHROPIC_API_KEY
        ? "set (discovery available)"
        : "not set (replay works; discovery needs it or --decider scripted:<flow>)",
      false,
    ]);
    rows.push([
      "state dir",
      true,
      `${projectRoot()}/state (audit chain + idempotency ledger)`,
      false,
    ]);
    for (const [name, ok, detail] of rows)
      console.log(`${ok ? "ok  " : "MISS"}  ${name.padEnd(28)} ${detail}`);
    process.exitCode = rows.every((r) => r[1] || !r[3]) ? 0 : 1;
  });

program
  .command("schema")
  .description("Print the JSON Schema of the capability artifact")
  .action(() => console.log(JSON.stringify(capabilityJsonSchema(), null, 2)));

program
  .command("tools")
  .description("Print the catalog as agent tool definitions (function-calling surface)")
  .action(() => {
    const store = new CapabilityStore();
    const tools = store.list().map((c) => capabilityToTool(store.load(`${c.name}@${c.version}`)));
    console.log(JSON.stringify(tools, null, 2));
  });

program
  .command("serve")
  .description(
    "Expose the catalog as an HTTP capability API for AI agents (one browser session per tenant)",
  )
  .option("--port <n>", "port", (v: string) => Number(v), 4780)
  .option("--headed", "show the browser", false)
  .option("--evidence-dir <dir>", "evidence root", "runs")
  .action(async (o) => {
    loadDotEnv();
    const server = await startCapabilityServer({
      port: o.port,
      headless: !o.headed,
      evidenceRoot: o.evidenceDir,
    });
    console.log(
      `capability API listening on ${server.url}  (GET /capabilities, POST /capabilities/:name/invoke)`,
    );
    const stop = async () => {
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`error: ${errorMessage(e)}`);
  process.exit(1);
});

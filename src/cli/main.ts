#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import { capabilityJsonSchema, Capability } from "../core/schema.js";
import { CapabilityStore, loadDotEnv } from "../catalog/store.js";
import { Redactor } from "../policy/redact.js";
import { capabilityToTool } from "../catalog/tools.js";
import {
  discoverCommand,
  formatDiscovery,
  formatResult,
  promoteOverrides,
  replayCommand,
  type ChaosSpec,
} from "./commands.js";
import { errorMessage } from "../core/errors.js";
import { startCapabilityServer } from "../catalog/server.js";

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
    });
    if (o.json)
      console.log(
        JSON.stringify(
          {
            ...out.result,
            capability: out.capability
              ? { name: out.capability.name, version: out.capability.version }
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
    else {
      console.log(formatDiscovery(out.result));
      for (const p of out.probes) console.log(`  probe ${p.name}: ${p.replay.status} — ${p.note}`);
    }
    process.exitCode = out.result.status === "success" ? 0 : 1;
  });

program
  .command("replay")
  .description("Replay a capability deterministically (no LLM) with input parameters")
  .argument("<capability>", "name, name@version, or artifact file path")
  .option("--tenant <id>", "tenant binding id", "summit")
  .option("--input <name=value>", "input parameter (repeatable)", parseKV, {})
  .option(
    "--approve <reason>",
    "explicit invocation approval for risky steps (recorded in evidence)",
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
      console.log(
        `${c.name}@${c.version}  [${c.status}] ${c.riskClass.padEnd(12)} in(${c.inputs.join(", ")}) -> out(${c.outputs.join(", ")})  ${c.title}`,
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
    console.log(`${cap.name}@${cap.version} [${cap.status}] — ${cap.title}`);
    console.log(cap.description);
    console.log(`goal: ${cap.goal}`);
    console.log(
      `app: ${cap.app.family} (${cap.app.surface}, profile ${cap.app.profile}); recorded on ${cap.provenance.tenant} by ${cap.provenance.recordedBy.kind}${cap.provenance.recordedBy.model ? `/${cap.provenance.recordedBy.model}` : ""} at ${cap.provenance.recordedAt}`,
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
        `  ${i + 1}. [${s.kind}${s.risk !== "safe" ? `, ${s.risk}` : ""}] ${s.name}${"target" in s ? `  strategies: ${s.target.strategies.map((t) => t.kind).join(" > ")}` : ""}${s.expect.length ? `  expect: ${s.expect.length}` : ""}`,
      ),
    );
    console.log(`checkpoint: ${cap.checkpoint.description}`);
    console.log("conditions:");
    for (const c of cap.conditions)
      console.log(`  ${c.id} (${c.class}, ${c.origin}): ${c.description}`);
    console.log(`stats: ${JSON.stringify(cap.stats)}`);
  });

program
  .command("validate")
  .description("Validate artifact files against the schema and the no-secrets rule")
  .argument("<files...>")
  .action((files: string[]) => {
    let bad = 0;
    for (const f of files) {
      try {
        Capability.parse(JSON.parse(fs.readFileSync(f, "utf8")));
        console.log(`ok    ${f}`);
      } catch (e) {
        bad++;
        console.log(`FAIL  ${f}: ${errorMessage(e).split("\n")[0]}`);
      }
    }
    process.exitCode = bad ? 1 : 0;
  });

program
  .command("approve")
  .description("Mark a capability as approved for unattended replay")
  .argument("<capability>")
  .requiredOption("--by <name>", "approver")
  .option("--notes <text>")
  .action((ref: string, o) => {
    const store = new CapabilityStore();
    const cap = store.load(ref);
    cap.status = "approved";
    cap.review = { approvedBy: o.by, approvedAt: new Date().toISOString(), notes: o.notes };
    const file = store.save(cap, new Redactor());
    console.log(`approved ${cap.name}@${cap.version} → ${file}`);
  });

program
  .command("promote")
  .description(
    "Turn the fallback resolutions of a replay run into tenant overrides (drift → specialisation, reviewed by a human)",
  )
  .argument("<capability>")
  .requiredOption("--tenant <id>", "tenant the run was executed on")
  .requiredOption(
    "--run <evidenceDir>",
    "evidence directory of the replay run (contains result.json)",
  )
  .option("--by <name>", "reviewer", process.env.USER ?? "reviewer")
  .action((ref: string, o) => {
    const store = new CapabilityStore();
    const cap = store.load(ref);
    const result = JSON.parse(fs.readFileSync(`${o.run}/result.json`, "utf8"));
    const { capability, promoted } = promoteOverrides(cap, o.tenant, result);
    if (promoted.length === 0)
      return console.log("no fallback resolutions in that run; nothing to promote");
    for (const id of promoted) {
      const t = capability.overrides[o.tenant]!.steps[id]!.target!;
      console.log(
        `override ${o.tenant}/${id}: strategies now ${t.strategies.map((s) => s.kind).join(" > ")}`,
      );
    }
    capability.review = {
      ...capability.review,
      notes: `${capability.review?.notes ?? ""} by ${o.by}`,
    };
    const file = store.save(capability, new Redactor());
    console.log(`saved ${capability.name}@${capability.version} (draft, needs approval) → ${file}`);
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

program.parseAsync(process.argv).catch((e) => {
  console.error(`error: ${errorMessage(e)}`);
  process.exit(1);
});

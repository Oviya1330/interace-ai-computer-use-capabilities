/**
 * End-to-end demonstration that produces the curated /evidence folder:
 *   1. discovery of two capabilities (LLM by default; --scripted runs the same pipeline
 *      without model access), each followed by a probe that learns an error condition and,
 *      for the safe one, a verification replay,
 *   2. deterministic replays covering success, business outcomes, recoverable conditions,
 *      a hard failure escalated to a human who takes over the live session, the approval
 *      gate, the four-eyes rule, duplicate invocations, cross-tenant drift → override
 *      promotion, assisted recovery, a condition learned from the human, a screenshot-driven
 *      replay, and a run of the generated Playwright script.
 *
 *   tsx scripts/demo.ts all [--scripted] [--out evidence] [--headed]
 *   tsx scripts/demo.ts discover | replay
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLegacyCore } from "../apps/legacycore/server.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import {
  approveCapability,
  discoverCommand,
  formatDiscovery,
  formatResult,
  promoteConditions,
  promoteOverrides,
  replayCommand,
  resetApp,
  type DiscoverOutcome,
  type ReplayArgs,
} from "../src/cli/commands.js";
import { loadDotEnv, loadPolicy } from "../src/catalog/store.js";
import type { RunResult } from "../src/core/result.js";
import { writeRunReport } from "../src/evidence/report.js";
import { generatePlaywrightScript } from "../src/catalog/codegen.js";
import { AuditLog } from "../src/hitl/audit.js";

const args = process.argv.slice(2);
const mode = (args.find((a) => !a.startsWith("--")) ?? "all") as "all" | "discover" | "replay";
const scripted = args.includes("--scripted");
const headed = args.includes("--headed");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1]! : "evidence";
const APP = "http://localhost:4173";
const log = (l: string) => process.stderr.write(l + "\n");
const say = (l: string) => process.stdout.write(l + "\n");

interface Row {
  n: string;
  what: string;
  status: string;
  detail: string;
  dir: string;
}
const rows: Row[] = [];

function record(n: string, what: string, r: RunResult): void {
  const detail =
    r.status === "success"
      ? `outputs ${JSON.stringify(r.outputs)}`
      : r.status === "business_outcome"
        ? `${r.outcome.code}: ${r.outcome.message}`
        : `${r.error.code} at ${r.error.stepId ?? "-"}: ${r.error.message}`;
  const extras = [
    r.recoveries.length
      ? `conditions: ${r.recoveries.map((c) => `${c.conditionId}→${c.handled}`).join(", ")}`
      : "",
    r.interventions.length
      ? `interventions: ${r.interventions.map((i) => `${i.type}→${i.resolution} (${i.humanActions} human actions)`).join(", ")}`
      : "",
    r.drift.warnings.length ? `drift: ${r.drift.warnings.length} fallback resolution(s)` : "",
    r.assists?.length
      ? `assists: ${r.assists.map((a) => `${a.stepId}→${a.decision}`).join(", ")}`
      : "",
    r.proposedConditions?.length
      ? `proposed conditions: ${r.proposedConditions.map((c) => c.id).join(", ")}`
      : "",
    r.ledger?.length ? `ledger: ${r.ledger.map((l) => `${l.stepId}:${l.status}`).join(", ")}` : "",
  ].filter(Boolean);
  rows.push({
    n,
    what,
    status: r.status.toUpperCase(),
    detail: [detail, ...extras].join("; "),
    dir: path.basename(r.evidence.dir),
  });
  writeRunReport(r.evidence.dir);
  say(formatResult(r));
}

function operatorBot(consoleUrl: string, opts: { click?: string; resolve: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = [
      "scripts/operator-bot.ts",
      "--console",
      consoleUrl,
      "--resolve",
      opts.resolve,
      "--timeout",
      "180000",
    ];
    if (opts.click) a.push("--click", opts.click);
    const child = spawn(process.execPath, ["--import", "tsx", ...a], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`operator-bot exited with ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  loadDotEnv();
  process.env.LEGACYCORE_PASSWORD ??= "Summit#2024!";
  process.env.LEGACYCORE_CASCADE_PASSWORD ??= "Cascade#2024!";
  if (!scripted && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    log(
      "ANTHROPIC_API_KEY is not set. Put it in .env (see .env.example) for the real LLM discovery run, or pass --scripted to run the pipeline without a model.",
    );
    process.exit(1);
  }
  const healthy = await fetch(`${APP}/__health`)
    .then((r) => r.ok)
    .catch(() => false);
  const app = healthy ? null : await startLegacyCore({ port: 4173, log: false });
  await resetApp(APP);
  if (mode !== "replay") {
    fs.rmSync(OUT, { recursive: true, force: true });
    for (const f of fs.readdirSync("capabilities"))
      if (f.endsWith(".json")) fs.unlinkSync(path.join("capabilities", f));
    // A fresh control-plane state for the demo (audit chain + ledger are snapshotted into the evidence).
    fs.rmSync("state", { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });
  const decider = scripted ? "scripted" : "llm";
  const rt = await createRuntime({
    tenantId: "summit",
    headless: !headed,
    evidenceRoot: OUT,
    tracing: true,
  });
  let cascade: Runtime | null = null;
  const discoveries: DiscoverOutcome[] = [];
  const rep = (label: string, a: Omit<ReplayArgs, "log" | "label">) =>
    replayCommand({ ...a, runtime: a.runtime ?? rt, label, log });
  try {
    log(`[demo] operator console: ${rt.console!.url}`);

    if (mode !== "replay") {
      say(
        `\n=== 1. Discovery: member.lookup_savings_balance (${decider}), probe for not-found, then a verification replay ===`,
      );
      const d1 = await discoverCommand({
        goal: "Look up member 10023 and read their current savings balance",
        tenant: "summit",
        inputs: { member_id: "10023" },
        sensitive: ["member_id"],
        name: "member.lookup_savings_balance",
        probes: [{ name: "not_found", inputs: { member_id: "99999" } }],
        decider: scripted ? "scripted:lookup_savings_balance" : "llm",
        runtime: rt,
        label: "01-discovery-lookup_savings_balance",
        log,
      });
      say(formatDiscovery(d1.result));
      if (d1.result.status !== "success")
        throw new Error(`discovery 1 failed: ${d1.result.error?.message}`);
      discoveries.push(d1);

      say(
        `\n=== 2. Discovery: member.open_share (${decider}), the irreversible Confirm needs an operator's approval; probe for a low deposit ===`,
      );
      const bot = operatorBot(rt.console!.url, { resolve: "approve" });
      const d2 = await discoverCommand({
        goal: "Open a new Club Savings sub-account (share) for member 10023 with a 25.00 initial deposit and reach the confirmation screen",
        tenant: "summit",
        inputs: {
          member_id: "10023",
          share_type: "Club Savings",
          description: "Vacation fund",
          initial_deposit: "25.00",
        },
        sensitive: ["member_id"],
        name: "member.open_share",
        probes: [{ name: "low_deposit", inputs: { initial_deposit: "1.00" } }],
        decider: scripted ? "scripted:open_new_share" : "llm",
        runtime: rt,
        label: "02-discovery-open_share",
        log,
      });
      await bot.catch((e) => log(`[demo] operator bot: ${e.message}`));
      say(formatDiscovery(d2.result));
      if (d2.result.status !== "success")
        throw new Error(`discovery 2 failed: ${d2.result.error?.message}`);
      discoveries.push(d2);
      // Review + approval, bound to the artifact's content hash.
      rt.store.save(
        approveCapability(
          rt.store.load("member.open_share"),
          "demo-reviewer",
          "Reviewed steps, dialog policy and the learned VALIDATION_ERROR condition.",
        ),
        rt.redactor,
      );
      // Restore seed balances for the replays; the reset drops server sessions too, so leave
      // the app so the next run signs on cleanly instead of trusting stale frames.
      await resetApp(APP);
      await rt.surface.navigate("about:blank");
    }

    if (mode !== "discover") {
      const lookup = "member.lookup_savings_balance";
      const share = "member.open_share";
      const who = { approvedBy: "supervisor.jane", requestedBy: "agent:servicing-assistant" };

      say("\n=== 3. Replay: success ===");
      record(
        "03",
        "lookup 10023 (happy path)",
        (
          await rep("03-replay-lookup-success", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "10023" },
          })
        )[0]!,
      );
      say("\n=== 4. Replay: business outcome MEMBER_NOT_FOUND ===");
      record(
        "04",
        "lookup 99999 (no such member)",
        (
          await rep("04-replay-lookup-not-found", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "99999" },
          })
        )[0]!,
      );
      say("\n=== 5. Replay: business outcome PERMISSION_DENIED ===");
      record(
        "05",
        "lookup 55555 (restricted account)",
        (
          await rep("05-replay-lookup-permission-denied", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "55555" },
          })
        )[0]!,
      );
      say("\n=== 6. Replay: session expiry mid-flow (re-authenticate, restart) ===");
      record(
        "06",
        "lookup with injected session expiry",
        (
          await rep("06-replay-chaos-session-expired", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "10024" },
            chaos: { scenario: "session_expired", count: 1, pathPattern: "/inquiry" },
          })
        )[0]!,
      );
      say(
        "\n=== 7. Replay: known interstitial (dismiss; the step's post-conditions already hold, so it is not re-run) ===",
      );
      record(
        "07",
        "lookup with injected System Notice",
        (
          await rep("07-replay-chaos-maintenance-notice", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "10024" },
            chaos: { scenario: "maintenance_notice", count: 1, pathPattern: "/inquiry" },
          })
        )[0]!,
      );
      say("\n=== 8. Replay: transient application error (wait, restart) ===");
      record(
        "08",
        "lookup with injected HTTP 500",
        (
          await rep("08-replay-chaos-app-error", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "10024" },
            chaos: { scenario: "app_error", count: 1, pathPattern: "/inquiry" },
          })
        )[0]!,
      );
      say("\n=== 9. Replay: slow load (bounded waiting) ===");
      record(
        "09",
        "lookup with injected 6s delay",
        (
          await rep("09-replay-chaos-slow", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "10024" },
            chaos: { scenario: "slow", count: 1, pathPattern: "/inquiry" },
          })
        )[0]!,
      );
      say(
        "\n=== 10. Replay: UNKNOWN interstitial → escalation → human takes over the live session → retry ===",
      );
      const bot = operatorBot(rt.console!.url, { click: "I Acknowledge", resolve: "retry" });
      const handoff = (
        await rep("10-replay-handoff-unknown-interstitial", {
          capability: lookup,
          tenant: "summit",
          inputs: { member_id: "10087" },
          chaos: { scenario: "security_bulletin", count: 1, pathPattern: "/inquiry" },
        })
      )[0]!;
      await bot.catch((e) => log(`[demo] operator bot: ${e.message}`));
      record("10", "lookup with an interstitial the profile does not know", handoff);

      say(
        "\n=== 11. Replay: irreversible capability, approved artifact + approval by a second person + idempotency key (unattended) ===",
      );
      const shareInputs = {
        member_id: "10024",
        share_type: "Money Market",
        description: "Rainy day",
        initial_deposit: "40.00",
      };
      record(
        "11",
        "open share for 10024 (approved artifact, second-person approval, idempotency key)",
        (
          await rep("11-replay-open-share-approved", {
            capability: share,
            tenant: "summit",
            inputs: shareInputs,
            approve: "ticket CU-4411: member requested a new share by phone",
            ...who,
            idempotencyKey: "CU-4411",
          })
        )[0]!,
      );
      say(
        "\n=== 11b. Replay: the same invocation again (same idempotency key) → DUPLICATE_INVOCATION, nothing posted ===",
      );
      record(
        "11b",
        "open share for 10024 repeated with the same idempotency key",
        (
          await rep("11b-replay-open-share-duplicate", {
            capability: share,
            tenant: "summit",
            inputs: shareInputs,
            approve: "ticket CU-4411 (retry)",
            ...who,
            idempotencyKey: "CU-4411",
          })
        )[0]!,
      );
      say(
        "\n=== 11c. Replay: approver equals requester → four-eyes rule pauses for a second person (operator denies) ===",
      );
      const denyBot = operatorBot(rt.console!.url, { resolve: "deny" });
      const fourEyes = (
        await rep("11c-replay-open-share-four-eyes", {
          capability: share,
          tenant: "summit",
          inputs: { ...shareInputs, description: "Self approved" },
          approve: "ticket CU-4413",
          approvedBy: "agent:servicing-assistant",
          requestedBy: "agent:servicing-assistant",
          idempotencyKey: "CU-4413",
        })
      )[0]!;
      await denyBot.catch((e) => log(`[demo] operator bot: ${e.message}`));
      record("11c", "open share approved by its own requester", fourEyes);
      say("\n=== 12. Replay: business outcome VALIDATION_ERROR (deposit below minimum) ===");
      record(
        "12",
        "open share with 1.00 deposit",
        (
          await rep("12-replay-open-share-validation-error", {
            capability: share,
            tenant: "summit",
            inputs: {
              member_id: "10024",
              share_type: "Savings",
              description: "Test",
              initial_deposit: "1.00",
            },
            approve: "ticket CU-4412",
            ...who,
            idempotencyKey: "CU-4412",
          })
        )[0]!,
      );
      say("\n=== 13. Replay: invalid input rejected before touching the UI ===");
      record(
        "13",
        "lookup with non-numeric member id",
        (
          await rep("13-replay-invalid-input", {
            capability: lookup,
            tenant: "summit",
            inputs: { member_id: "abc" },
          })
        )[0]!,
      );

      say(
        "\n=== 14. Replay on a second tenant (same vendor product, relabelled UI): fallback tiers + drift report ===",
      );
      cascade = await createRuntime({
        tenantId: "cascade",
        headless: !headed,
        evidenceRoot: OUT,
        console: false,
        tracing: false,
        // The demo opts in to bounded assisted recovery for the cross-tenant runs (off by default in policy.yaml).
        policy: { ...loadPolicy(), assist: { enabled: true, maxPerRun: 3 } },
      });
      const drift = (
        await rep("14-replay-cascade-drift", {
          capability: lookup,
          tenant: "cascade",
          inputs: { member_id: "10023" },
          runtime: cascade,
        })
      )[0]!;
      record("14", "lookup 10023 on tenant cascade (base artifact)", drift);
      say("\n=== 15. Promote the fallback resolutions to tenant overrides, replay again ===");
      let latestLookup = lookup;
      const { capability, promoted } = promoteOverrides(rt.store.load(lookup), "cascade", drift);
      if (promoted.length) {
        rt.store.save(capability, rt.redactor);
        latestLookup = `${lookup}@${capability.version}`;
        say(
          `promoted overrides for cascade on steps ${promoted.join(", ")} → ${capability.name}@${capability.version} (draft)`,
        );
        record(
          "15",
          "lookup 10023 on cascade with promoted overrides",
          (
            await rep("15-replay-cascade-overrides", {
              capability: latestLookup,
              tenant: "cascade",
              inputs: { member_id: "10023" },
              runtime: cascade,
            })
          )[0]!,
        );
      }
      say(
        "\n=== 16. Replay on cascade with the base artifact, semantic locators only, bounded assisted recovery (max 3 per run) ===",
      );
      record(
        "16",
        "lookup 10023 on cascade with the BASE artifact, locators role/label/text/table only, bounded model-assisted recovery (max 3)",
        (
          await rep("16-replay-cascade-assisted", {
            capability: `${lookup}@1.0.0`,
            tenant: "cascade",
            inputs: { member_id: "10023" },
            locators: ["role", "label", "text", "table"],
            assist: scripted ? "scripted:lookup_savings_balance" : "llm",
            runtime: cascade,
          })
        )[0]!,
      );

      say(
        "\n=== 17. Learn from the human: promote the condition proposed by run 10, replay the same fault with no human ===",
      );
      const learned = promoteConditions(
        rt.store.load(latestLookup),
        handoff.proposedConditions ?? [],
      );
      if (learned.promoted.length) {
        rt.store.save(learned.capability, rt.redactor);
        latestLookup = `${lookup}@${learned.capability.version}`;
        say(
          `promoted condition(s) ${learned.promoted.join(", ")} → ${learned.capability.name}@${learned.capability.version} (draft)`,
        );
        record(
          "17",
          "lookup 10087 with the same unknown interstitial, now handled by the learned condition",
          (
            await rep("17-replay-learned-condition", {
              capability: latestLookup,
              tenant: "summit",
              inputs: { member_id: "10087" },
              chaos: { scenario: "security_bulletin", count: 1, pathPattern: "/inquiry" },
            })
          )[0]!,
        );
      }
      say(
        "\n=== 18. Screenshot-driven replay: controls by visual template matching, the parameterised link by text (the OCR stand-in), no structural locators ===",
      );
      record(
        "18",
        "lookup 10023 with locators restricted to visual + text",
        (
          await rep("18-replay-vision-only", {
            capability: latestLookup,
            tenant: "summit",
            inputs: { member_id: "10023" },
            locators: ["visual", "text"],
          })
        )[0]!,
      );

      say(
        "\n=== 19. Code generation: standalone Playwright script from the artifact, executed once ===",
      );
      const genFile = path.join(OUT, "artifacts", "generated-lookup_savings_balance.ts");
      fs.mkdirSync(path.dirname(genFile), { recursive: true });
      fs.writeFileSync(
        genFile,
        generatePlaywrightScript(rt.store.load(lookup), rt.profile, rt.tenant, {
          member_id: "10024",
        }),
      );
      try {
        // Async: when the demo serves the app itself, a sync spawn would block it.
        const { stdout: out } = await promisify(execFile)(
          process.execPath,
          ["--import", "tsx", genFile, '{"member_id":"10024"}'],
          {
            encoding: "utf8",
            timeout: 120_000,
            env: process.env,
          },
        );
        fs.writeFileSync(
          path.join(OUT, "artifacts", "generated-lookup_savings_balance.output.json"),
          out,
        );
        rows.push({
          n: "19",
          what: "generated Playwright script for lookup (member 10024)",
          status: String(JSON.parse(out).status).toUpperCase(),
          detail: out.trim().replace(/\s+/g, " "),
          dir: "artifacts/generated-lookup_savings_balance.ts",
        });
        say(`generated script ran: ${out.trim().replace(/\s+/g, " ")}`);
      } catch (e) {
        rows.push({
          n: "19",
          what: "generated Playwright script for lookup",
          status: "FAILURE",
          detail: e instanceof Error ? e.message : String(e),
          dir: "artifacts/generated-lookup_savings_balance.ts",
        });
      }
    }

    // ---- artifacts, state snapshot, index
    const artDir = path.join(OUT, "artifacts");
    fs.mkdirSync(artDir, { recursive: true });
    for (const f of fs.readdirSync("capabilities"))
      if (f.endsWith(".json")) fs.copyFileSync(path.join("capabilities", f), path.join(artDir, f));
    fs.mkdirSync(path.join(OUT, "state"), { recursive: true });
    for (const f of ["audit.jsonl", "ledger.jsonl"])
      if (fs.existsSync(path.join(rt.stateDir, f)))
        fs.copyFileSync(path.join(rt.stateDir, f), path.join(OUT, "state", f));
    const auditCheck = AuditLog.verify(path.join(OUT, "state", "audit.jsonl"));

    const index: string[] = [];
    index.push("# Evidence", "");
    index.push(
      `Generated by \`npm run demo:all${scripted ? " -- --scripted" : ""}\` on ${new Date().toISOString()}.`,
      "",
    );
    if (scripted) {
      index.push(
        "**Note:** the discovery runs below used the scripted decider (no model), which drives the same loop, recorder, policy gate and evidence path. Regenerate with `npm run demo:all` (needs `ANTHROPIC_API_KEY`) to produce the genuine LLM-driven discovery evidence the brief requires.",
        "",
      );
    }
    index.push(
      `Every run directory has a \`report.html\` (open it in a browser: steps with screenshots, conditions, interventions, assists, timeline), \`events.jsonl\` (structured, redacted log of what the system did and why), \`result.json\` (the result contract) and \`steps/*.png\` (one screenshot per step; discovery screenshots carry the numbered marks the model saw). On failure there is a \`failure/\` folder (screenshot, DOM snapshot of every frame, Playwright \`trace.zip\`). Discovery runs also contain \`transcript.json\` (the model conversation, image-free, redacted) and \`artifact.json\`. Interventions are stored under \`interventions/\` with the human's actions and screenshots.`,
      "",
    );
    index.push(
      `The control-plane state snapshot is in \`state/\`: \`audit.jsonl\` is the hash-chained audit log (${auditCheck.ok ? `chain verified, ${auditCheck.entries} entries` : `CHAIN BROKEN at ${auditCheck.brokenAt}`}; check with \`./bin/cua.js audit verify --file evidence/state/audit.jsonl\`) and \`ledger.jsonl\` the idempotency ledger.`,
      "",
    );
    index.push("## Discovery runs", "");
    for (const d of discoveries) {
      const r = d.result;
      const v = d.capability?.provenance.verification;
      index.push(
        `- \`${path.basename(r.evidence.dir)}\` — ${r.status.toUpperCase()}: "${r.goal}" → \`${d.capability?.name}@${d.capability?.version}\` (${d.capability?.steps.length} steps, risk ${d.capability?.policy.riskClass}); decider **${r.llm.model}**, ${r.actions} actions, ${r.llm.calls} model calls (${r.llm.inputTokens} in / ${r.llm.outputTokens} out tokens)${r.interventions.length ? `; interventions: ${r.interventions.map((i) => `${i.type}→${i.resolution}`).join(", ")}` : ""}. Probes: ${d.probes.map((p) => `${p.name} → ${p.condition ? `learned \`${p.condition.id}\` (${p.condition.class})` : p.note}`).join("; ")}. Verification replay: ${v ? `${v.status}${v.reason ? ` (${v.reason})` : ""}` : "n/a"}.`,
      );
    }
    if (discoveries.length === 0)
      index.push("(replay-only run; discovery evidence from an earlier run is kept above)");
    index.push(
      "",
      "## Replay runs",
      "",
      "| # | Run | Status | Details | Directory |",
      "|---|---|---|---|---|",
    );
    for (const r of rows)
      index.push(
        `| ${r.n} | ${r.what} | ${r.status} | ${r.detail.replace(/\|/g, "\\|")} | \`${r.dir}\` |`,
      );
    index.push(
      "",
      "## Artifacts",
      "",
      ...fs.readdirSync(artDir).map((f) => `- \`artifacts/${f}\``),
    );
    // Goals and scenario labels carry member numbers; mask them like every other evidence file.
    fs.writeFileSync(
      path.join(OUT, "README.md"),
      rt.redactor.redactString(index.join("\n")) + "\n",
    );
    say(`\nEvidence written to ${path.resolve(OUT)} (index: ${path.join(OUT, "README.md")})`);
  } finally {
    await cascade?.close();
    await rt.close();
    await app?.close();
  }
}

main().catch((e) => {
  log(`demo failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});

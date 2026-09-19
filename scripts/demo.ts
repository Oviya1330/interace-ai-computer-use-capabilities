/**
 * End-to-end demonstration that produces the curated /evidence folder:
 *   1. discovery of two capabilities (LLM by default; --scripted runs the same pipeline
 *      without model access), each followed by a probe that learns an error condition,
 *   2. deterministic replays covering success, business outcomes, recoverable conditions,
 *      a hard failure escalated to a human who takes over the live session, the approval
 *      gate for an irreversible action, and cross-tenant drift → override promotion.
 *
 *   tsx scripts/demo.ts all [--scripted] [--out evidence] [--headed]
 *   tsx scripts/demo.ts discover | replay
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startLegacyCore } from "../apps/legacycore/server.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import {
  discoverCommand,
  promoteOverrides,
  replayCommand,
  resetApp,
  formatResult,
  formatDiscovery,
  type DiscoverOutcome,
} from "../src/cli/commands.js";
import { loadDotEnv } from "../src/catalog/store.js";
import type { RunResult } from "../src/core/result.js";

const args = process.argv.slice(2);
const mode = (args.find((a) => !a.startsWith("--")) ?? "all") as "all" | "discover" | "replay";
const scripted = args.includes("--scripted");
const headed = args.includes("--headed");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1]! : "evidence";
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
  ].filter(Boolean);
  rows.push({
    n,
    what,
    status: r.status.toUpperCase(),
    detail: [detail, ...extras].join("; "),
    dir: path.basename(r.evidence.dir),
  });
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
  const healthy = await fetch("http://localhost:4173/__health")
    .then((r) => r.ok)
    .catch(() => false);
  const app = healthy ? null : await startLegacyCore({ port: 4173, log: false });
  await resetApp("http://localhost:4173");
  if (mode !== "replay") {
    fs.rmSync(OUT, { recursive: true, force: true });
    for (const f of fs.readdirSync("capabilities"))
      if (f.endsWith(".json")) fs.unlinkSync(path.join("capabilities", f));
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
  try {
    log(`[demo] operator console: ${rt.console!.url}`);

    if (mode !== "replay") {
      say("\n=== 1. Discovery: member.lookup_savings_balance (" + decider + ") ===");
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
        "\n=== 2. Discovery: member.open_share (" +
          decider +
          ") — irreversible step needs an operator's approval ===",
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
      const cap = rt.store.load("member.open_share");
      cap.status = "approved";
      cap.review = {
        approvedBy: "demo-reviewer",
        approvedAt: new Date().toISOString(),
        notes: "Reviewed steps, dialog policy and learned VALIDATION_ERROR condition.",
      };
      rt.store.save(cap, rt.redactor);
      // Restore seed balances for the replays; the reset also drops server sessions, so
      // leave the app so the next run signs on cleanly instead of trusting stale frames.
      await resetApp("http://localhost:4173");
      await rt.surface.navigate("about:blank");
    }

    if (mode !== "discover") {
      const lookup = "member.lookup_savings_balance";
      const share = "member.open_share";
      const rep = (label: string, args: Parameters<typeof replayCommand>[0]) =>
        replayCommand({ ...args, runtime: args.runtime ?? rt, label, log });

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
      say("\n=== 7. Replay: known interstitial (dismiss, retry step) ===");
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
        "\n=== 11. Replay: irreversible capability, approved artifact + invocation approval (unattended) ===",
      );
      record(
        "11",
        "open share for 10024 (approved, unattended)",
        (
          await rep("11-replay-open-share-approved", {
            capability: share,
            tenant: "summit",
            inputs: {
              member_id: "10024",
              share_type: "Money Market",
              description: "Rainy day",
              initial_deposit: "40.00",
            },
            approve: "ticket CU-4411: member requested a new share by phone",
          })
        )[0]!,
      );
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
      const { capability, promoted } = promoteOverrides(rt.store.load(lookup), "cascade", drift);
      if (promoted.length) {
        rt.store.save(capability, rt.redactor);
        say(
          `promoted overrides for cascade on steps ${promoted.join(", ")} → ${capability.name}@${capability.version} (draft)`,
        );
        record(
          "15",
          "lookup 10023 on cascade with promoted overrides",
          (
            await rep("15-replay-cascade-overrides", {
              capability: `${lookup}@${capability.version}`,
              tenant: "cascade",
              inputs: { member_id: "10023" },
              runtime: cascade,
            })
          )[0]!,
        );
      }
    }

    // ---- artifacts + index
    const artDir = path.join(OUT, "artifacts");
    fs.mkdirSync(artDir, { recursive: true });
    for (const f of fs.readdirSync("capabilities"))
      if (f.endsWith(".json")) fs.copyFileSync(path.join("capabilities", f), path.join(artDir, f));
    const index: string[] = [];
    index.push("# Evidence", "");
    index.push(
      `Generated by \`npm run demo:all${scripted ? " -- --scripted" : ""}\` on ${new Date().toISOString()}.`,
      "",
    );
    index.push(
      "Every run directory contains `events.jsonl` (structured, redacted log of what the system did and why), `result.json` (the structured result contract), `steps/*.png` (screenshots per step; discovery screenshots carry the numbered marks the model saw), and on failure `failure/` (screenshot, DOM snapshot of every frame, Playwright `trace.zip`). Discovery runs also contain `transcript.json` (the model conversation, image-free, redacted) and `artifact.json` (the recorded capability). Interventions are stored under `interventions/` with the human's actions.",
      "",
    );
    if (scripted)
      index.push(
        "**Note:** the discovery runs below used the scripted decider (no model), which drives the same loop, recorder, policy gate and evidence path. Regenerate with `npm run demo:all` (needs `ANTHROPIC_API_KEY`) to produce the genuine LLM-driven discovery evidence the brief requires.",
        "",
      );
    index.push("## Discovery runs", "");
    for (const d of discoveries) {
      const r = d.result;
      index.push(
        `- \`${path.basename(r.evidence.dir)}\` — ${r.status.toUpperCase()}: "${r.goal}" → \`${d.capability?.name}@${d.capability?.version}\` (${d.capability?.steps.length} steps, risk ${d.capability?.policy.riskClass}); decider **${r.llm.model}**, ${r.actions} actions, ${r.llm.calls} model calls (${r.llm.inputTokens} in / ${r.llm.outputTokens} out tokens)${r.interventions.length ? `; interventions: ${r.interventions.map((i) => `${i.type}→${i.resolution}`).join(", ")}` : ""}. Probes: ${d.probes.map((p) => `${p.name} → ${p.condition ? `learned \`${p.condition.id}\` (${p.condition.class})` : p.note}`).join("; ")}`,
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
    fs.writeFileSync(path.join(OUT, "README.md"), index.join("\n") + "\n");
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

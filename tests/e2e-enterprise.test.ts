/**
 * End-to-end coverage of the enterprise-grade behaviours: pre-conditions, idempotency,
 * four-eyes, assisted recovery, conditions learned from a human, data masking, integrity,
 * and a vision-only replay (the desktop path) — all against the mock app, no model needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLegacyCore } from "../apps/legacycore/server.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import {
  approveCapability,
  discoverCommand,
  promoteConditions,
  replayCommand,
  resetApp,
} from "../src/cli/commands.js";
import { Capability } from "../src/core/schema.js";
import type { InterventionRequest } from "../src/hitl/broker.js";
import { AuditLog } from "../src/hitl/audit.js";
import { decode } from "../src/surface/png.js";
import { renderRunReport } from "../src/evidence/report.js";
import { generatePlaywrightScript } from "../src/catalog/codegen.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

process.env.LEGACYCORE_PASSWORD ??= "Summit#2024!";
process.env.LEGACYCORE_CASCADE_PASSWORD ??= "Cascade#2024!";

let app: { close(): Promise<void> } | null = null;
let root: string;
let rt: Runtime;
const quiet = () => {};

beforeAll(async () => {
  const healthy = await fetch("http://localhost:4173/__health")
    .then((r) => r.ok)
    .catch(() => false);
  if (!healthy) app = await startLegacyCore({ port: 4173, log: false });
  await resetApp("http://localhost:4173");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-e2e2-"));
  for (const d of ["profiles", "tenants"])
    fs.cpSync(path.join(process.cwd(), d), path.join(root, d), { recursive: true });
  // Classify the SSN cell for masking and enable assisted recovery for this test root.
  const profilePath = path.join(root, "profiles", "legacycore-teller.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  profile.dataPolicy = { maskLabels: ["SSN"], maskNamePatterns: [] };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  fs.writeFileSync(
    path.join(root, "policy.yaml"),
    fs
      .readFileSync("policy.yaml", "utf8")
      .replace("assist:\n  enabled: false", "assist:\n  enabled: true"),
  );
  rt = await createRuntime({
    tenantId: "summit",
    headless: process.env.HEADED !== "1",
    root,
    evidenceRoot: path.join(root, "runs"),
    consolePort: 0,
    tracing: false,
  });
  // Record both capabilities once (scripted), with verification on the safe one.
  const lookup = await discoverCommand({
    goal: "Look up member 10023 and read their current savings balance",
    tenant: "summit",
    inputs: { member_id: "10023" },
    sensitive: ["member_id"],
    decider: "scripted:lookup_savings_balance",
    runtime: rt,
    log: quiet,
  });
  expect(lookup.result.status).toBe("success");
  const approvals = (req: InterventionRequest) => {
    if (req.type === "approval")
      rt.broker!.resolve(req.id, { kind: "approve", operator: "tester" });
  };
  rt.broker!.on("raised", approvals);
  const share = await discoverCommand({
    goal: "Open a new Club Savings share for member 10023 with a 25.00 initial deposit",
    tenant: "summit",
    inputs: {
      member_id: "10023",
      share_type: "Club Savings",
      description: "Vacation fund",
      initial_deposit: "25.00",
    },
    sensitive: ["member_id"],
    decider: "scripted:open_new_share",
    runtime: rt,
    log: quiet,
  });
  rt.broker!.off("raised", approvals);
  expect(share.result.status).toBe("success");
  await resetApp("http://localhost:4173");
  await rt.surface.navigate("about:blank");
});

afterAll(async () => {
  await rt?.close();
  await app?.close();
});

describe("verification, pre-conditions and integrity", () => {
  it("records pre-conditions and verifies the safe capability right after recording", () => {
    const cap = rt.store.load("member.lookup_savings_balance");
    expect(cap.provenance.verification?.status).toBe("passed");
    expect(cap.steps[0]!.precondition.length).toBeGreaterThan(0);
    expect(
      cap.steps[0]!.precondition.some((p) => p.kind === "text" && p.text.includes("Welcome")),
    ).toBe(true);
    expect(cap.integrity?.algorithm).toBe("sha256");
    const share = rt.store.load("member.open_share");
    expect(share.provenance.verification?.status).toBe("skipped");
  });

  it("refuses to act on the wrong screen (PRECONDITION_FAILED) with debuggable evidence", async () => {
    const cap = rt.store.load("member.lookup_savings_balance");
    const wrong = {
      ...cap,
      name: "member.lookup_wrong_screen",
      steps: cap.steps.map((s, i) =>
        i === 1
          ? {
              ...s,
              precondition: [{ kind: "text" as const, text: "Search Results", frame: ["main"] }],
            }
          : s,
      ),
    };
    const file = path.join(root, "wrong.json");
    fs.writeFileSync(file, JSON.stringify(wrong));
    const noConsole = await createRuntime({
      tenantId: "summit",
      headless: process.env.HEADED !== "1",
      root,
      evidenceRoot: path.join(root, "runs"),
      console: false,
      tracing: false,
    });
    try {
      const [r] = await replayCommand({
        capability: file,
        tenant: "summit",
        inputs: { member_id: "10023" },
        runtime: noConsole,
        log: quiet,
      });
      expect(r!.status).toBe("failure");
      if (r!.status === "failure") {
        expect(r!.error.code).toBe("PRECONDITION_FAILED");
        expect(r!.error.stepId).toBe("s02-type-member-number");
        expect(r!.error.expected).toContain("Search Results");
      }
    } finally {
      await noConsole.close();
    }
  });

  it("treats an approved artifact that was edited afterwards as draft", async () => {
    const approved = approveCapability(rt.store.load("member.open_share"), "reviewer");
    rt.store.save(approved, rt.redactor);
    const tampered = {
      ...rt.store.load("member.open_share"),
      description: "edited after approval",
    };
    const file = path.join(root, "tampered.json");
    fs.writeFileSync(file, JSON.stringify(tampered));
    rt.broker!.once("raised", (req: InterventionRequest) =>
      rt.broker!.resolve(req.id, {
        kind: "deny",
        operator: "tester",
        note: "not the approved content",
      }),
    );
    const [r] = await replayCommand({
      capability: file,
      tenant: "summit",
      inputs: {
        member_id: "10024",
        share_type: "Savings",
        description: "x",
        initial_deposit: "20.00",
      },
      approve: "ticket",
      approvedBy: "supervisor",
      requestedBy: "agent",
      runtime: rt,
      log: quiet,
    });
    expect(r!.integrity?.effectiveStatus).toBe("draft");
    expect(r!.status).toBe("failure");
    if (r!.status === "failure") expect(r!.error.code).toBe("POLICY_BLOCKED");
  });
});

describe("irreversible steps: four-eyes, caps and idempotency", () => {
  it("pauses when the approver is the requester and allows a second person", async () => {
    let fourEyesRequest: InterventionRequest | null = null;
    rt.broker!.once("raised", (req: InterventionRequest) => {
      fourEyesRequest = req;
      rt.broker!.resolve(req.id, { kind: "deny", operator: "tester" });
    });
    const inputs = {
      member_id: "10024",
      share_type: "Savings",
      description: "Four eyes",
      initial_deposit: "20.00",
    };
    const [self] = await replayCommand({
      capability: "member.open_share",
      tenant: "summit",
      inputs,
      approve: "ticket",
      approvedBy: "agent",
      requestedBy: "agent",
      runtime: rt,
      log: quiet,
    });
    expect(self!.status).toBe("failure");
    expect(fourEyesRequest!.reason.message).toMatch(/approved by its own requester/);
    const [ok] = await replayCommand({
      capability: "member.open_share",
      tenant: "summit",
      inputs,
      approve: "ticket",
      approvedBy: "supervisor",
      requestedBy: "agent",
      idempotencyKey: "four-eyes-1",
      runtime: rt,
      log: quiet,
    });
    expect(ok!.status).toBe("success");
    // intent before the post, committed after it, and a final commit with all outputs at run end
    expect(ok!.ledger?.map((l) => l.status)).toEqual(["intent", "committed", "committed"]);
  });

  it("returns DUPLICATE_INVOCATION with the earlier result instead of posting twice", async () => {
    const inputs = {
      member_id: "10087",
      share_type: "Savings",
      description: "Idempotent",
      initial_deposit: "15.00",
    };
    const first = (
      await replayCommand({
        capability: "member.open_share",
        tenant: "summit",
        inputs,
        approve: "ticket",
        approvedBy: "supervisor",
        requestedBy: "agent",
        idempotencyKey: "dup-1",
        runtime: rt,
        log: quiet,
      })
    )[0]!;
    expect(first.status).toBe("success");
    const second = (
      await replayCommand({
        capability: "member.open_share",
        tenant: "summit",
        inputs,
        approve: "ticket",
        approvedBy: "supervisor",
        requestedBy: "agent",
        idempotencyKey: "dup-1",
        runtime: rt,
        log: quiet,
      })
    )[0]!;
    expect(second.status).toBe("business_outcome");
    if (second.status === "business_outcome" && first.status === "success") {
      expect(second.outcome.code).toBe("DUPLICATE_INVOCATION");
      expect((second.outcome.data as { outputs: Record<string, unknown> }).outputs).toEqual(
        first.outputs,
      );
    }
    // The audit chain recorded every approval, control-plane event and ledger commit intact.
    expect(AuditLog.verify(rt.audit.file).ok).toBe(true);
    expect(AuditLog.read(rt.audit.file).some((e) => e.type === "ledger.duplicate")).toBe(true);
  });
});

describe("assisted recovery and learning from humans", () => {
  it("re-finds relabelled controls with one bounded assist when semantic locators are restricted", async () => {
    const cascade = await createRuntime({
      tenantId: "cascade",
      headless: process.env.HEADED !== "1",
      root,
      evidenceRoot: path.join(root, "runs"),
      console: false,
      tracing: false,
    });
    try {
      const [r] = await replayCommand({
        capability: "member.lookup_savings_balance",
        tenant: "cascade",
        inputs: { member_id: "10023" },
        locators: ["role", "label", "text", "table"],
        assist: "scripted:lookup_savings_balance",
        runtime: cascade,
        log: quiet,
      });
      // Only one assist per run is allowed by policy; a second relabelled control fails without a human.
      expect(r!.assists.length).toBe(1);
      expect(r!.assists[0]!.decision).toBe("applied");
      expect(r!.assists[0]!.proposed?.name).toBe("Member Lookup");
      expect(r!.steps[0]!.status).toBe("recovered");
      expect(r!.steps[0]!.proposedOverride?.resolvedVia).toBe("assist");
      expect(r!.status).toBe("failure");
    } finally {
      await cascade.close();
    }
  });

  it("turns an operator's fix into a proposed condition that later replays without a human", async () => {
    const raised = new Promise<InterventionRequest>((resolve) =>
      rt.broker!.once("raised", resolve),
    );
    const run = replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10087" },
      chaos: { scenario: "security_bulletin", count: 1, pathPattern: "/inquiry" },
      runtime: rt,
      log: quiet,
    });
    const req = await raised;
    rt.broker!.takeControl(req.id, "tester");
    await rt.session!.startScreencast();
    const btn = req.elements.find((e) => e.name === "I Acknowledge")!;
    await rt.session!.mouse({
      type: "mousePressed",
      x: btn.bbox.x + btn.bbox.w / 2,
      y: btn.bbox.y + btn.bbox.h / 2,
    });
    await rt.session!.mouse({
      type: "mouseReleased",
      x: btn.bbox.x + btn.bbox.w / 2,
      y: btn.bbox.y + btn.bbox.h / 2,
    });
    await rt.session!.stopScreencast();
    rt.broker!.resolve(req.id, { kind: "retry", operator: "tester" });
    const [r] = await run;
    expect(r!.status).toBe("success");
    expect(r!.proposedConditions).toHaveLength(1);
    const proposed = r!.proposedConditions[0]!;
    expect(proposed.origin).toBe("human");
    expect(proposed.detect).toEqual({ kind: "text", text: "Security Bulletin", frame: ["main"] });
    expect(proposed.handler?.kind).toBe("dismiss");
    const { capability, promoted } = promoteConditions(
      rt.store.load("member.lookup_savings_balance"),
      r!.proposedConditions,
    );
    expect(promoted).toEqual([proposed.id]);
    rt.store.save(capability, rt.redactor);
    const [again] = await replayCommand({
      capability: `member.lookup_savings_balance@${capability.version}`,
      tenant: "summit",
      inputs: { member_id: "10087" },
      chaos: { scenario: "security_bulletin", count: 1, pathPattern: "/inquiry" },
      runtime: rt,
      log: quiet,
    });
    expect(again!.status).toBe("success");
    expect(again!.interventions).toEqual([]);
    expect(again!.recoveries.map((c) => `${c.conditionId}:${c.handled}`)).toContain(
      `${proposed.id}:resolved`,
    );
  });
});

describe("data classification, vision-only replay, reports and codegen", () => {
  it("masks classified fields in screenshots and hides them from the element list", async () => {
    const [r] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10023" },
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("success");
    const obs = await rt.surface.observe();
    const ssn = obs.elements.find((e) => e.labelText === "SSN");
    expect(ssn).toBeTruthy();
    expect(ssn!.sensitive).toBe(true);
    expect(ssn!.text).toBe("[masked]");
    const img = decode(obs.screenshotPlain);
    const x = Math.floor(ssn!.bbox.x + ssn!.bbox.w / 2);
    const y = Math.floor(ssn!.bbox.y + ssn!.bbox.h / 2);
    const p = (y * img.width + x) * 4;
    expect(img.data[p]).toBeLessThan(40);
  });

  it("replays with visual template matching (plus text as the OCR stand-in), the way a screenshot-driven surface would", async () => {
    const [r] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10023" },
      locators: ["visual", "text"],
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("success");
    const actionSteps = r!.steps.filter((s) => s.kind !== "extract");
    // Controls with a stable look resolve by template; the parameterised member link needs text.
    expect(actionSteps.map((s) => s.resolution?.strategy)).toEqual([
      "visual",
      "visual",
      "visual",
      "text",
    ]);
    if (r!.status === "success") expect(r!.outputs.savings_balance).toBe(4250.37);
  });

  it("renders an HTML report and generates a runnable Playwright script", async () => {
    const [r] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10024" },
      runtime: rt,
      log: quiet,
    });
    const html = renderRunReport(r!.evidence.dir);
    expect(html).toContain("member.lookup_savings_balance");
    expect(html).toContain("steps/01-s01-click-member-inquiry.png");
    expect(fs.existsSync(path.join(r!.evidence.dir, "report.html"))).toBe(true);
    const cap = rt.store.load("member.lookup_savings_balance");
    const code = generatePlaywrightScript(cap, rt.profile, rt.tenant, { member_id: "10024" });
    // Input values are passed at run time, never baked into the generated file.
    expect(code).not.toContain("10024");
    // The generated script imports "playwright", so it must live where node can resolve it.
    fs.mkdirSync(path.join(process.cwd(), "runs"), { recursive: true });
    const file = path.join(process.cwd(), "runs", `generated-${Date.now()}.ts`);
    fs.writeFileSync(file, code);
    // Async on purpose: the app may be served from this very process, and a sync spawn would
    // block its event loop so the child's page.goto could never get a response.
    const { stdout: out } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", file, '{"member_id":"10024"}'],
      {
        env: { ...process.env, LEGACYCORE_PASSWORD: process.env.LEGACYCORE_PASSWORD },
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("success");
    expect(typeof parsed.outputs.savings_balance).toBe("number");
    expect(parsed.outputs.savings_balance).toBeGreaterThan(0);
  });
});

describe("artifact schema round trip", () => {
  it("parses every saved artifact, including lineage and verification fields", () => {
    for (const c of rt.store.list())
      expect(() => Capability.parse(rt.store.load(`${c.name}@${c.version}`))).not.toThrow();
  });
});

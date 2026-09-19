/**
 * End-to-end tests against the mock LegacyCore app (no model access needed):
 * scripted discovery -> artifact -> deterministic replay -> outcomes / recoveries ->
 * human handoff on the live session -> approval gate -> cross-tenant drift & overrides.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLegacyCore } from "../apps/legacycore/server.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { discoverCommand, promoteOverrides, replayCommand, resetApp } from "../src/cli/commands.js";
import { Capability } from "../src/core/schema.js";
import type { InterventionRequest } from "../src/hitl/broker.js";
import { capabilityToTool } from "../src/catalog/tools.js";

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-e2e-"));
  for (const d of ["profiles", "tenants"])
    fs.cpSync(path.join(process.cwd(), d), path.join(root, d), { recursive: true });
  fs.copyFileSync("policy.yaml", path.join(root, "policy.yaml"));
  rt = await createRuntime({
    tenantId: "summit",
    headless: true,
    root,
    evidenceRoot: path.join(root, "runs"),
    consolePort: 0,
    tracing: false,
  });
});

afterAll(async () => {
  await rt?.close();
  await app?.close();
});

const nextIntervention = (runtime: Runtime): Promise<InterventionRequest> =>
  new Promise((resolve) => runtime.broker!.once("raised", resolve));

describe("discovery → artifact", () => {
  it("records a parameterised, PII-free capability and learns the not-found outcome from a probe", async () => {
    const out = await discoverCommand({
      goal: "Look up member 10023 and read their current savings balance",
      tenant: "summit",
      inputs: { member_id: "10023" },
      sensitive: ["member_id"],
      decider: "scripted:lookup_savings_balance",
      probes: [{ name: "not_found", inputs: { member_id: "99999" } }],
      runtime: rt,
      log: quiet,
    });
    expect(out.result.status).toBe("success");
    const cap = Capability.parse(out.capability);
    expect(cap.name).toBe("member.lookup_savings_balance");
    expect(cap.steps.map((s) => s.kind)).toEqual(["click", "type", "click", "click", "extract"]);
    const typeStep = cap.steps[1]!;
    expect(typeStep.kind === "type" && typeStep.value).toEqual({
      kind: "param",
      name: "member_id",
    });
    const extract = cap.steps[4]!;
    expect(extract.kind === "extract" && extract.target.strategies[0]!.kind).toBe("table");
    expect(cap.inputs.member_id!.sensitivity).toBe("pii");
    expect(cap.inputs.member_id!.example).toBeUndefined();
    expect(cap.goal).toContain("{{member_id}}");
    const text = fs.readFileSync(out.artifactPath!, "utf8");
    expect(text).not.toContain("10023");
    expect(cap.conditions.map((c) => c.id)).toContain("member_not_found");
    expect(fs.existsSync(path.join(out.result.evidence.dir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(out.result.evidence.dir, "transcript.json"))).toBe(true);
    expect(fs.existsSync(path.join(out.result.evidence.dir, "steps", "01-observe.png"))).toBe(true);
  });
});

describe("deterministic replay", () => {
  it("returns declared outputs on the happy path using primary strategies", async () => {
    const [r] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10023" },
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("success");
    if (r!.status === "success") expect(r!.outputs).toEqual({ savings_balance: 4250.37 });
    expect(r!.steps.every((s) => s.resolution?.tier === 0)).toBe(true);
    expect(r!.drift.warnings).toEqual([]);
  });

  it("reports business outcomes instead of crashing", async () => {
    const [notFound] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "99999" },
      runtime: rt,
      log: quiet,
    });
    expect(notFound!.status).toBe("business_outcome");
    if (notFound!.status === "business_outcome")
      expect(notFound!.outcome.code).toBe("MEMBER_NOT_FOUND");
    const denied = (
      await replayCommand({
        capability: "member.lookup_savings_balance",
        tenant: "summit",
        inputs: { member_id: "55555" },
        runtime: rt,
        log: quiet,
      })
    )[0]!;
    expect(denied.status).toBe("business_outcome");
    if (denied.status === "business_outcome") expect(denied.outcome.code).toBe("PERMISSION_DENIED");
  });

  it("rejects invalid inputs before touching the UI", async () => {
    const [r] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "abc" },
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("failure");
    if (r!.status === "failure") expect(r!.error.code).toBe("INVALID_INPUT");
  });

  it("recovers from an interstitial, a session expiry and a transient app error", async () => {
    for (const [scenario, cond] of [
      ["maintenance_notice", "maintenance_notice"],
      ["session_expired", "session_expired"],
      ["app_error", "app_error"],
    ] as const) {
      const [r] = await replayCommand({
        capability: "member.lookup_savings_balance",
        tenant: "summit",
        inputs: { member_id: "10024" },
        chaos: { scenario, count: 1, pathPattern: "/inquiry" },
        runtime: rt,
        log: quiet,
      });
      expect(r!.status, scenario).toBe("success");
      expect(
        r!.recoveries.map((c) => `${c.conditionId}:${c.handled}`),
        scenario,
      ).toContain(`${cond}:resolved`);
    }
  });

  it("waits through a slow load without any recovery", async () => {
    const [r] = await replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10024" },
      chaos: { scenario: "slow", count: 1, pathPattern: "/inquiry", delayMs: 4000 },
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("success");
    expect(r!.recoveries).toEqual([]);
  });

  it("fails fast with debuggable evidence when no operator is available", async () => {
    const noConsole = await createRuntime({
      tenantId: "summit",
      headless: true,
      root,
      evidenceRoot: path.join(root, "runs"),
      console: false,
      tracing: true,
    });
    try {
      const [r] = await replayCommand({
        capability: "member.lookup_savings_balance",
        tenant: "summit",
        inputs: { member_id: "10024" },
        chaos: { scenario: "security_bulletin", count: 1, pathPattern: "/inquiry" },
        runtime: noConsole,
        log: quiet,
      });
      expect(r!.status).toBe("failure");
      if (r!.status === "failure") {
        expect(r!.error.code).toBe("EXPECTATION_FAILED");
        expect(r!.error.stepId).toBe("s01-click-member-inquiry");
        expect(r!.error.expected).toContain("Member Inquiry");
        expect(r!.error.evidence.some((f) => f.endsWith(".png"))).toBe(true);
        expect(r!.error.evidence.some((f) => f.endsWith(".html"))).toBe(true);
        expect(r!.evidence.trace).toBe("failure/trace.zip");
        expect(fs.existsSync(path.join(r!.evidence.dir, "failure", "trace.zip"))).toBe(true);
      }
    } finally {
      await noConsole.close();
    }
  });
});

describe("human-in-the-loop handoff", () => {
  it("pauses, lets a human drive the same live session, records the action and resumes", async () => {
    const raised = nextIntervention(rt);
    const run = replayCommand({
      capability: "member.lookup_savings_balance",
      tenant: "summit",
      inputs: { member_id: "10087" },
      chaos: { scenario: "security_bulletin", count: 1, pathPattern: "/inquiry" },
      runtime: rt,
      log: quiet,
    });
    const req = await raised;
    expect(req.type).toBe("failure");
    expect(req.allowedResolutions).toContain("retry");
    expect(req.screenshot).toBeTruthy();
    // Input is refused while automation holds control.
    await expect(rt.session!.mouse({ type: "mousePressed", x: 10, y: 10 })).rejects.toThrow(
      /automation holds control/,
    );
    rt.broker!.takeControl(req.id, "tester");
    await rt.session!.startScreencast();
    const frame = await new Promise<{ width: number }>((resolve) => rt.session!.onFrame(resolve));
    expect(frame.width).toBeGreaterThan(0);
    const btn = req.elements.find((e) => e.name === "I Acknowledge")!;
    expect(btn).toBeTruthy();
    const x = btn.bbox.x + btn.bbox.w / 2;
    const y = btn.bbox.y + btn.bbox.h / 2;
    await rt.session!.mouse({ type: "mousePressed", x, y });
    await rt.session!.mouse({ type: "mouseReleased", x, y });
    await rt.session!.stopScreencast();
    rt.broker!.resolve(req.id, {
      kind: "retry",
      operator: "tester",
      note: "acknowledged the bulletin",
    });
    const [r] = await run;
    expect(r!.status).toBe("success");
    expect(r!.interventions).toHaveLength(1);
    expect(r!.interventions[0]!.resolution).toBe("retry");
    expect(r!.interventions[0]!.controlTransfers).toBe(1);
    expect(r!.interventions[0]!.humanActions).toBe(1);
    const record = rt.broker!.get(req.id)!;
    expect(record.humanActions[0]!.element?.name).toBe("I Acknowledge");
    expect(record.humanActions[0]!.target?.strategies[0]).toEqual({
      kind: "role",
      role: "button",
      name: "I Acknowledge",
      exact: true,
    });
    expect(record.control.owner).toBe("automation");
    expect(fs.existsSync(path.join(r!.evidence.dir, "interventions", `${req.id}.json`))).toBe(true);
  });
});

describe("safety: risky actions and approvals", () => {
  it("gates the irreversible Confirm click during discovery and records the accepted dialog", async () => {
    const approvals: InterventionRequest[] = [];
    const autoApprove = (req: InterventionRequest) => {
      if (req.type === "approval") {
        approvals.push(req);
        rt.broker!.resolve(req.id, { kind: "approve", operator: "tester" });
      }
    };
    rt.broker!.on("raised", autoApprove);
    const out = await discoverCommand({
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
      probes: [{ name: "low_deposit", inputs: { initial_deposit: "1.00" } }],
      runtime: rt,
      log: quiet,
    });
    rt.broker!.off("raised", autoApprove);
    expect(out.result.status).toBe("success");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.reason.message).toMatch(/irreversible action "Confirm"/);
    const cap = out.capability!;
    expect(cap.policy.riskClass).toBe("irreversible");
    expect(cap.policy.requiresApproval).toBe(true);
    const confirm = cap.steps.find((s) => s.id.includes("confirm"))!;
    expect(confirm.risk).toBe("irreversible");
    expect(confirm.dialog).toEqual({
      messagePattern: "Post this new share to member {{member_id}}\\?",
      response: "accept",
    });
    expect(cap.conditions.map((c) => c.id)).toContain("validation_error");
    expect(fs.readFileSync(out.artifactPath!, "utf8")).not.toContain("10023");
  });

  it("blocks unattended replay of a draft artifact when the operator denies", async () => {
    rt.broker!.once("raised", (req: InterventionRequest) =>
      rt.broker!.resolve(req.id, { kind: "deny", operator: "tester", note: "not authorised" }),
    );
    const [r] = await replayCommand({
      capability: "member.open_share",
      tenant: "summit",
      inputs: {
        member_id: "10024",
        share_type: "Savings",
        description: "x",
        initial_deposit: "20.00",
      },
      approve: "ticket 1",
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("failure");
    if (r!.status === "failure") {
      expect(r!.error.code).toBe("POLICY_BLOCKED");
      expect(r!.error.stepId).toContain("confirm");
    }
    expect(r!.interventions[0]!.resolution).toBe("deny");
  });

  it("replays unattended once the artifact is approved and the invocation carries an approval", async () => {
    const cap = rt.store.load("member.open_share");
    cap.status = "approved";
    cap.review = { approvedBy: "tester", approvedAt: new Date().toISOString() };
    rt.store.save(cap, rt.redactor);
    const [r] = await replayCommand({
      capability: "member.open_share",
      tenant: "summit",
      inputs: {
        member_id: "10024",
        share_type: "Money Market",
        description: "Rainy day",
        initial_deposit: "40.00",
      },
      approve: "ticket CU-1",
      runtime: rt,
      log: quiet,
    });
    expect(r!.status).toBe("success");
    if (r!.status === "success")
      expect(String(r!.outputs.confirmation_number)).toMatch(/^CNF-[0-9A-F]{8}$/);
    expect(r!.interventions).toEqual([]);
    const confirmStep = r!.steps.find((s) => s.stepId.includes("confirm"))!;
    expect(confirmStep.dialog?.response).toBe("accept");
    const [bad] = await replayCommand({
      capability: "member.open_share",
      tenant: "summit",
      inputs: {
        member_id: "10024",
        share_type: "Savings",
        description: "x",
        initial_deposit: "1.00",
      },
      approve: "ticket CU-2",
      runtime: rt,
      log: quiet,
    });
    expect(bad!.status).toBe("business_outcome");
    if (bad!.status === "business_outcome") expect(bad!.outcome.code).toBe("VALIDATION_ERROR");
  });

  it("exposes approved capabilities as typed tools for agents", () => {
    const tool = capabilityToTool(rt.store.load("member.open_share"));
    expect(tool.name).toBe("member__open_share");
    expect((tool.input_schema as { required: string[] }).required).toEqual([
      "member_id",
      "share_type",
      "description",
      "initial_deposit",
    ]);
    expect(tool.description).toContain("VALIDATION_ERROR");
  });
});

describe("multi-tenant reuse", () => {
  it("replays on a relabelled tenant via fallback tiers, then promotes overrides to restore tier-0 targeting", async () => {
    const cascade = await createRuntime({
      tenantId: "cascade",
      headless: true,
      root,
      evidenceRoot: path.join(root, "runs"),
      console: false,
      tracing: false,
    });
    try {
      const [first] = await replayCommand({
        capability: "member.lookup_savings_balance",
        tenant: "cascade",
        inputs: { member_id: "10023" },
        runtime: cascade,
        log: quiet,
      });
      expect(first!.status).toBe("success");
      if (first!.status === "success") expect(first!.outputs).toEqual({ savings_balance: 2780.1 });
      expect(first!.drift.warnings.length).toBeGreaterThanOrEqual(2);
      const drifted = first!.steps.filter((s) => s.proposedOverride);
      expect(drifted.length).toBeGreaterThanOrEqual(2);
      const { capability, promoted } = promoteOverrides(
        cascade.store.load("member.lookup_savings_balance"),
        "cascade",
        first!,
      );
      expect(promoted).toEqual(drifted.map((s) => s.stepId));
      expect(capability.version).toBe("1.1.0");
      expect(capability.status).toBe("draft");
      cascade.store.save(capability, cascade.redactor);
      const [second] = await replayCommand({
        capability: "member.lookup_savings_balance@1.1.0",
        tenant: "cascade",
        inputs: { member_id: "10023" },
        runtime: cascade,
        log: quiet,
      });
      expect(second!.status).toBe("success");
      expect(second!.drift.warnings).toEqual([]);
      expect(
        second!.steps.filter((s) => s.overridden?.includes("target")).map((s) => s.stepId),
      ).toEqual(promoted);
      // The base tenant is untouched by the override.
      const [base] = await replayCommand({
        capability: "member.lookup_savings_balance@1.1.0",
        tenant: "summit",
        inputs: { member_id: "10023" },
        runtime: rt,
        log: quiet,
      });
      expect(base!.status).toBe("success");
      expect(base!.drift.warnings).toEqual([]);
    } finally {
      await cascade.close();
    }
  });
});

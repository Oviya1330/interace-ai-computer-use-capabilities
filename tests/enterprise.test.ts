import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, SCHEMA_VERSION } from "../src/core/schema.js";
import { checkIntegrity, contentHash, withIntegrity } from "../src/catalog/integrity.js";
import { IdempotencyLedger } from "../src/replay/ledger.js";
import { AuditLog } from "../src/hitl/audit.js";
import { PolicyGate, PolicyConfig } from "../src/policy/policy.js";
import { diffCapabilities } from "../src/catalog/diff.js";
import { approveCapability, promoteConditions } from "../src/cli/commands.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cua-ent-"));

const minimal = () =>
  Capability.parse({
    schemaVersion: SCHEMA_VERSION,
    id: "01",
    name: "member.lookup",
    version: "1.0.0",
    status: "draft",
    title: "t",
    description: "d",
    goal: "g",
    app: { profile: "p", surface: "legacy_web", family: "f" },
    entry: { url: { kind: "template", template: "{{base_url}}/" } },
    inputs: { member_id: { type: "string", description: "m", sensitivity: "pii" } },
    outputs: {},
    policy: {
      riskClass: "irreversible",
      sideEffects: "creates_record",
      requiresApproval: true,
      allowedOrigins: ["http://localhost:4173"],
    },
    steps: [
      {
        id: "s1",
        kind: "click",
        name: "Confirm",
        risk: "irreversible",
        target: {
          description: "x",
          frame: ["main"],
          strategies: [{ kind: "role", role: "button", name: "Confirm" }],
        },
      },
    ],
    checkpoint: { description: "c", expect: [{ kind: "text", text: "Done" }] },
    provenance: {
      recordedAt: "2026-01-01T00:00:00Z",
      recordedBy: { kind: "scripted" },
      discoveryRunId: "r",
      tenant: "summit",
    },
  });

describe("artifact integrity", () => {
  it("hashes content deterministically and ignores bookkeeping fields", () => {
    const cap = minimal();
    const h1 = contentHash(cap);
    expect(contentHash({ ...cap, stats: { ...cap.stats, replays: 9 }, status: "approved" })).toBe(
      h1,
    );
    expect(contentHash({ ...cap, title: "changed" })).not.toBe(h1);
    expect(withIntegrity(cap).integrity?.hash).toBe(h1);
  });
  it("demotes an approved artifact to draft when its content changed after approval", () => {
    const approved = approveCapability(minimal(), "reviewer");
    expect(checkIntegrity(approved).effectiveStatus).toBe("approved");
    const edited = {
      ...approved,
      steps: [{ ...approved.steps[0]!, name: "Confirm and post" }],
    } as typeof approved;
    const check = checkIntegrity(edited);
    expect(check.effectiveStatus).toBe("draft");
    expect(check.approvedHashMatches).toBe(false);
    expect(check.problems[0]).toMatch(/changed since approval/);
    const noHash = { ...minimal(), status: "approved" as const, review: { approvedBy: "x" } };
    expect(checkIntegrity(noHash).effectiveStatus).toBe("draft");
  });
});

describe("idempotency ledger", () => {
  it("tracks intent → committed and exposes duplicates and unresolved intents", () => {
    const ledger = new IdempotencyLedger(path.join(tmp(), "ledger.jsonl"));
    expect(ledger.lookup("k1", "member.open_share", "s10")).toBeNull();
    ledger.append({
      key: "k1",
      capability: "member.open_share",
      version: "1.0.0",
      tenant: "summit",
      stepId: "s10",
      runId: "r1",
      status: "intent",
    });
    expect(ledger.lookup("k1", "member.open_share", "s10")?.status).toBe("intent");
    ledger.append({
      key: "k1",
      capability: "member.open_share",
      version: "1.0.0",
      tenant: "summit",
      stepId: "s10",
      runId: "r1",
      status: "committed",
      outputs: { confirmation_number: "CNF-1" },
    });
    expect(ledger.lookup("k1", "member.open_share", "s10")?.status).toBe("committed");
    expect(ledger.committedOutputs("k1", "member.open_share")).toEqual({
      confirmation_number: "CNF-1",
    });
    expect(ledger.lookup("k1", "member.open_share", "s11")).toBeNull();
    expect(ledger.committedOutputs("k2", "member.open_share")).toBeNull();
  });
});

describe("hash-chained audit log", () => {
  it("chains entries and detects tampering", () => {
    const file = path.join(tmp(), "audit.jsonl");
    const log = new AuditLog(file);
    log.record("intervention.raised", "automation", { id: "int_1" }, "run1");
    log.record("control.transfer", "jane", { id: "int_1", owner: "human" }, "run1");
    const reopened = new AuditLog(file);
    reopened.record("intervention.resolved", "jane", { id: "int_1", kind: "retry" }, "run1");
    expect(AuditLog.verify(file)).toEqual({ ok: true, entries: 3, brokenAt: null });
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]!);
    tampered.actor = "mallory";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(AuditLog.verify(file)).toEqual({ ok: false, entries: 3, brokenAt: 1 });
  });
});

describe("four-eyes rule", () => {
  const gate = new PolicyGate(
    PolicyConfig.parse({ allow: { origins: ["http://localhost:4173"] } }),
  );
  const risky = { kind: "click" as const, url: "http://localhost:4173/x", controlName: "Confirm" };
  it("refuses an invocation approved by its own requester", () => {
    const d = gate.evaluate(risky, {
      mode: "replay",
      artifactStatus: "approved",
      invocationApproved: true,
      requestedBy: "bot",
      approvedBy: "bot",
    });
    expect(d.verdict).toBe("confirm");
    expect(d.rule).toBe("risk.fourEyes");
  });
  it("allows when a second person approved", () => {
    const d = gate.evaluate(risky, {
      mode: "replay",
      artifactStatus: "approved",
      invocationApproved: true,
      requestedBy: "bot",
      approvedBy: "supervisor",
    });
    expect(d.verdict).toBe("allow");
  });
  it("can be switched off by policy", () => {
    const off = new PolicyGate(
      PolicyConfig.parse({
        allow: { origins: ["http://localhost:4173"] },
        risk: { fourEyes: false },
      }),
    );
    expect(
      off.evaluate(risky, {
        mode: "replay",
        artifactStatus: "approved",
        invocationApproved: true,
        requestedBy: "bot",
        approvedBy: "bot",
      }).verdict,
    ).toBe("allow");
  });
});

describe("promotion and diff", () => {
  it("promotes human-learned conditions into a new draft version with lineage", () => {
    const cap = approveCapability(minimal(), "reviewer");
    const { capability, promoted } = promoteConditions(cap, [
      {
        id: "human_security_bulletin",
        description: "d",
        detect: { kind: "text", text: "Security Bulletin" },
        class: "recoverable",
        handler: {
          kind: "dismiss",
          target: {
            description: "ack",
            frame: ["main"],
            strategies: [{ kind: "role", role: "button", name: "I Acknowledge" }],
          },
          then: "retry_step",
        },
        origin: "human",
      },
    ]);
    expect(promoted).toEqual(["human_security_bulletin"]);
    expect(capability.version).toBe("1.1.0");
    expect(capability.status).toBe("draft");
    expect(capability.provenance.derivedFrom?.version).toBe("1.0.0");
    const lines = diffCapabilities(cap, capability);
    expect(lines.some((l) => l.startsWith("condition +human_security_bulletin"))).toBe(true);
    expect(promoteConditions(capability, capability.conditions).promoted).toEqual([]);
  });
});

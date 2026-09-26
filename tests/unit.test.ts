import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  AppProfile,
  Capability,
  SCHEMA_VERSION,
  capabilityJsonSchema,
} from "../src/core/schema.js";
import { maskPatternsFor } from "../src/runtime.js";
import {
  interpolate,
  parameterize,
  templateToRegex,
  resolveValue,
  MissingParamError,
} from "../src/core/template.js";
import { PolicyGate, PolicyConfig } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { EnvSecretStore, SecretUnavailableError } from "../src/policy/secrets.js";
import { parseValue } from "../src/replay/parse.js";
import { Recorder, canonicalUrlPattern, inferParse } from "../src/agent/recorder.js";
import type { AgentAction } from "../src/agent/decider.js";
import type { ElementInfo, Observation, Surface } from "../src/surface/types.js";

describe("template", () => {
  it("interpolates and rejects missing params", () => {
    expect(
      interpolate("{{base_url}}/member/{{member_id}}", { base_url: "http://x", member_id: "1" }),
    ).toBe("http://x/member/1");
    expect(() => interpolate("{{nope}}", {})).toThrow(MissingParamError);
  });
  it("parameterises literals longest-value-first", () => {
    expect(parameterize("goMember('10023')", { member_id: "10023", other: "100" })).toBe(
      "goMember('{{member_id}}')",
    );
    expect(parameterize("ab", { x: "ab" })).toBe("ab"); // too short to parameterise
  });
  it("turns url templates into regexes with escaped values", () => {
    const re = templateToRegex("^{{base_url}}/member/{{member_id}}(\\?.*)?$", {
      base_url: "http://h/t/s",
      member_id: "10023",
    });
    expect(re.test("http://h/t/s/member/10023")).toBe(true);
    expect(re.test("http://h/t/s/member/10024")).toBe(false);
  });
  it("resolves secrets via the store and never exposes them as literals", () => {
    const red = new Redactor();
    const store = new EnvSecretStore({ pw: "env:TEST_PW" }, red, { TEST_PW: "hunter22" });
    expect(resolveValue({ kind: "secret", ref: "pw" }, {}, store)).toEqual({
      value: "hunter22",
      sensitive: true,
    });
    expect(red.redactString("password is hunter22")).toBe("password is [REDACTED:secret]");
    expect(() => store.resolve("missing")).toThrow(SecretUnavailableError);
  });
});

describe("canonical url patterns", () => {
  it("replaces base url, params and numeric segments", () => {
    const p = canonicalUrlPattern(
      "http://localhost:4173/t/summit/member/10023/share/new?x=1",
      { base_url: "http://localhost:4173/t/summit", member_id: "10023" },
      "http://localhost:4173/t/summit",
    );
    expect(p).toBe("^{{base_url}}/member/{{member_id}}/share/new(\\?.*)?$");
    const re = templateToRegex(p, {
      base_url: "http://localhost:4173/t/cascade",
      member_id: "10087",
    });
    expect(re.test("http://localhost:4173/t/cascade/member/10087/share/new")).toBe(true);
  });
  it("generalises unknown numeric ids", () => {
    const p = canonicalUrlPattern(
      "http://h/app/txn/98765",
      { base_url: "http://h/app" },
      "http://h/app",
    );
    expect(templateToRegex(p, { base_url: "http://h/app" }).test("http://h/app/txn/1")).toBe(true);
  });
});

describe("parsers", () => {
  it("parses currency, numbers, regex", () => {
    expect(parseValue("$4,250.37", { type: "currency" })).toBe(4250.37);
    expect(parseValue("($12.00)", { type: "currency" })).toBe(-12);
    expect(parseValue("1,234", { type: "number" })).toBe(1234);
    expect(parseValue("CNF-ABCD1234", { type: "regex", pattern: "CNF-([A-Z0-9]+)" })).toBe(
      "ABCD1234",
    );
    expect(() => parseValue("n/a", { type: "currency" })).toThrow(/currency/);
    expect(inferParse("$1.00")).toBe("currency");
    expect(inferParse("12")).toBe("number");
    expect(inferParse("Active")).toBe("text");
  });
});

describe("policy gate", () => {
  const gate = new PolicyGate(
    PolicyConfig.parse({
      allow: { origins: ["http://localhost:4173"], pathPatterns: ["^/t/summit/"] },
      deny: { pathPatterns: ["^/__", "/logoff"] },
    }),
  );
  it("blocks origins and denied paths regardless of risk", () => {
    expect(
      gate.evaluate({ kind: "click", url: "http://evil.example/x" }, { mode: "replay" }).verdict,
    ).toBe("deny");
    expect(
      gate.evaluate(
        { kind: "navigate", url: "http://localhost:4173/__chaos" },
        { mode: "discovery" },
      ).verdict,
    ).toBe("deny");
    expect(
      gate.evaluate(
        { kind: "click", url: "http://localhost:4173/t/summit/logoff" },
        { mode: "discovery" },
      ).verdict,
    ).toBe("deny");
    expect(
      gate.evaluate({ kind: "navigate", url: "javascript:alert(1)" }, { mode: "discovery" })
        .verdict,
    ).toBe("deny");
  });
  it("classifies risk from the control's meaning, including Enter-key submissions", () => {
    expect(
      gate.classifyRisk({
        kind: "click",
        url: "http://localhost:4173/t/summit/x",
        controlName: "Search",
      }),
    ).toBe("safe");
    expect(
      gate.classifyRisk({
        kind: "click",
        url: "http://localhost:4173/t/summit/x",
        controlName: "Confirm",
      }),
    ).toBe("irreversible");
    expect(
      gate.classifyRisk({
        kind: "click",
        url: "http://localhost:4173/t/summit/x",
        controlName: "Save",
      }),
    ).toBe("mutating");
    expect(
      gate.classifyRisk({
        kind: "type",
        url: "http://localhost:4173/t/summit/x",
        pressEnter: true,
        formSubmitLabels: ["Post"],
      }),
    ).toBe("irreversible");
  });
  it("requires confirmation for risky actions in discovery and on unapproved replays", () => {
    const risky = {
      kind: "click" as const,
      url: "http://localhost:4173/t/summit/x",
      controlName: "Confirm",
    };
    expect(gate.evaluate(risky, { mode: "discovery" }).verdict).toBe("confirm");
    expect(
      gate.evaluate(risky, { mode: "replay", artifactStatus: "draft", invocationApproved: true })
        .verdict,
    ).toBe("confirm");
    expect(
      gate.evaluate(risky, {
        mode: "replay",
        artifactStatus: "approved",
        invocationApproved: false,
      }).verdict,
    ).toBe("confirm");
    expect(
      gate.evaluate(risky, { mode: "replay", artifactStatus: "approved", invocationApproved: true })
        .verdict,
    ).toBe("allow");
  });
});

describe("redactor", () => {
  it("classifies member name, address and phone by exact label, not neighbouring labels", () => {
    const profile = AppProfile.parse(
      JSON.parse(fs.readFileSync("profiles/legacycore-teller.json", "utf8")),
    );
    const res = maskPatternsFor(profile).map((p) => new RegExp(p, "i"));
    const masked = (label: string) => res.some((re) => re.test(label));
    for (const l of ["Name", "Name:", "Member", "Address", "Phone", "SSN"])
      expect(masked(l)).toBe(true);
    for (const l of ["Last Name", "Member #", "Member Since", "Share Type", "Nickname"])
      expect(masked(l)).toBe(false);
  });
  it("masks secrets, sensitive values, patterns and secret-looking keys", () => {
    const r = new Redactor();
    r.registerSecret("Summit#2024!");
    r.registerSensitive("10023", "pii");
    const out = r.redact({
      note: "typed Summit#2024! for member 10023, ssn 123-45-6789",
      passwd: "x",
      nested: ["10023"],
    });
    expect(out).toEqual({
      note: "typed [REDACTED:secret] for member [pii:1***3], ssn [REDACTED:ssn]",
      passwd: "[REDACTED:key]",
      nested: ["[pii:1***3]"],
    });
    expect(() => r.assertClean("contains Summit#2024!", "artifact")).toThrow(/secret/);
  });
});

describe("artifact schema", () => {
  const minimal = {
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
    outputs: { balance: { type: "number", description: "b", sensitivity: "financial" } },
    policy: {
      riskClass: "safe",
      sideEffects: "none",
      requiresApproval: false,
      allowedOrigins: ["http://localhost:4173"],
    },
    steps: [
      {
        id: "s1",
        kind: "click",
        name: "click",
        target: {
          description: "x",
          frame: ["main"],
          strategies: [{ kind: "role", role: "link", name: "Member Inquiry" }],
        },
      },
    ],
    checkpoint: { description: "c", expect: [{ kind: "text", text: "Accounts" }] },
    provenance: {
      recordedAt: "2026-01-01T00:00:00Z",
      recordedBy: { kind: "llm", model: "m" },
      discoveryRunId: "r",
      tenant: "summit",
    },
  };
  it("parses a minimal artifact and fills defaults", () => {
    const cap = Capability.parse(minimal);
    expect(cap.steps[0]!.risk).toBe("safe");
    expect(cap.conditions).toEqual([]);
    expect(cap.stats.replays).toBe(0);
  });
  it("rejects bad names, versions and empty strategies", () => {
    expect(() => Capability.parse({ ...minimal, name: "Bad Name" })).toThrow();
    expect(() => Capability.parse({ ...minimal, version: "1" })).toThrow();
    expect(() =>
      Capability.parse({
        ...minimal,
        steps: [{ ...minimal.steps[0], target: { description: "x", strategies: [] } }],
      }),
    ).toThrow();
  });
  it("exports a JSON schema for reviewers", () => {
    const js = capabilityJsonSchema();
    expect(js).toHaveProperty("properties");
  });
});

describe("recorder", () => {
  const stubSurface = {
    describeTarget: (el: ElementInfo) => ({ description: `the "${el.text}" cell`, strategies: [] }),
  } as unknown as Surface;
  const el = (ref: string, text: string): ElementInfo =>
    ({ ref, frame: ["main"], role: "cell", name: "", text, attrs: {} }) as unknown as ElementInfo;
  const obs = (landmark: string): Observation =>
    ({
      frames: [{ path: ["main"], url: "http://x/t/summit/member/10023" }],
      elements: [],
      dialogs: [],
      texts: {},
      landmark,
      screenshotPlain: Buffer.alloc(0),
    }) as unknown as Observation;
  const act = (a: object) => a as unknown as AgentAction;

  it("never turns an extracted value into the checkpoint text", () => {
    const r = new Recorder(stubSurface, { member_id: "10023" }, "http://x/t/summit", ["main"]);
    const balance = el("e39", "$4,250.37");
    const screen = obs("Member Detail");
    r.recordAction(
      act({
        id: "1",
        tool: "extract",
        ref: "e39",
        output: "savings_balance",
        parse: "currency",
        why: "read",
      }),
      balance,
      screen,
      "safe",
      [],
      { raw: "$4,250.37", value: 4250.37 },
    );
    r.recordAction(
      act({ id: "2", tool: "done", evidence_ref: "e39", summary: "ok" }),
      balance,
      screen,
      "safe",
      [],
    );
    const texts = r
      .buildCheckpoint(screen)
      .expect.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts).not.toContain("$4,250.37");
    expect(texts).toContain("Member Detail");
  });

  it("never turns a masked (classified) cell into the checkpoint text", () => {
    const r = new Recorder(stubSurface, {}, "http://x/t/summit", ["main"]);
    const nameCell = { ...el("e9", "[masked]"), sensitive: true } as ElementInfo;
    r.recordAction(
      act({ id: "1", tool: "done", evidence_ref: "e9", summary: "ok" }),
      nameCell,
      obs("Share Opened"),
      "safe",
      [],
    );
    const texts = r
      .buildCheckpoint(obs("Share Opened"))
      .expect.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts).toEqual(["Share Opened"]);
  });

  it("keeps a non-data evidence element as the checkpoint", () => {
    const r = new Recorder(stubSurface, {}, "http://x/t/summit", ["main"]);
    const heading = el("e2", "Share Opened");
    r.recordAction(
      act({ id: "1", tool: "done", evidence_ref: "e2", summary: "ok" }),
      heading,
      obs("x"),
      "safe",
      [],
    );
    const texts = r
      .buildCheckpoint(obs("x"))
      .expect.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts).toEqual(["Share Opened"]);
  });

  it("guards a digits-only input with a pattern when the model proposes none", () => {
    const r = new Recorder(stubSurface, { member_id: "10023", nickname: "Alice" }, "http://x", [
      "main",
    ]);
    const cap = r.assemble({
      contract: {
        name: "member.lookup",
        title: "Lookup",
        description: "Look up a member",
        inputs: [
          {
            name: "member_id",
            type: "string",
            description: "id",
            sensitivity: "pii",
            pattern: null,
          },
          {
            name: "nickname",
            type: "string",
            description: "n",
            sensitivity: "none",
            pattern: null,
          },
        ],
        outputs: [],
        checkpointDescription: "",
        sideEffects: "none",
      },
      version: "1.0.0",
      goal: "g",
      profileId: "p",
      surface: "legacy_web",
      family: "f",
      tenant: "t",
      runId: "r",
      decider: { kind: "llm", model: "m" },
      checkpoint: { description: "", expect: [] },
      allowedOrigins: [],
      inputSensitivity: {},
      tenantParamNames: [],
      toolVersions: {},
    });
    expect(cap.inputs.member_id?.pattern).toBe("^\\d+$");
    expect(new RegExp(cap.inputs.member_id!.pattern!).test("abc")).toBe(false);
    expect(cap.inputs.nickname?.pattern).toBeUndefined();
  });
});

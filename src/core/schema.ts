/**
 * Capability artifact schema (v1).
 *
 * This is the contract between three parties:
 *   - the discovery agent (LLM) that RECORDS a flow once,
 *   - human reviewers who APPROVE it,
 *   - the deterministic replay engine that EXECUTES it on behalf of calling AI agents.
 *
 * Design rules:
 *   1. Everything a replay needs is here; nothing from the model transcript is needed.
 *   2. Targets are described by an ordered list of independent locator strategies, most
 *      semantic first (role/name, label, table relation) and most brittle last (css/xpath/visual),
 *      so the artifact survives markup churn and can be executed by non-DOM surfaces.
 *   3. Values are references (param / secret / literal / template), never inlined secrets.
 *   4. Runtime conditions (the error taxonomy) are first-class and classified into
 *      business outcome / recoverable / hard failure, each with an explicit handler.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Value references
// ---------------------------------------------------------------------------

export const ValueRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  /** Supplied by the caller per invocation; declared in `inputs`. */
  z.object({ kind: z.literal("param"), name: z.string() }),
  /** Resolved at runtime from the tenant's secret store. Never serialised. */
  z.object({ kind: z.literal("secret"), ref: z.string() }),
  /** "{{base_url}}/member/{{member_id}}" — params and tenant params are interpolated. */
  z.object({ kind: z.literal("template"), template: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRef>;

// ---------------------------------------------------------------------------
// Targets: how a control is identified
// ---------------------------------------------------------------------------

export const BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type BBox = z.infer<typeof BBox>;

/**
 * Strategies are tried in order until exactly one visible match is found.
 * String fields may contain `{{param}}` placeholders.
 */
export const TargetStrategy = z.discriminatedUnion("kind", [
  /** Accessibility role + accessible name. Works on web AND desktop (UIA / AX). */
  z.object({
    kind: z.literal("role"),
    role: z.string(),
    name: z.string().optional(),
    exact: z.boolean().optional(),
  }),
  /**
   * Control associated with visible label text — for legacy forms the label is the adjacent cell.
   * control="value" targets the value cell next to a label cell in a key/value table.
   */
  z.object({
    kind: z.literal("label"),
    text: z.string(),
    control: z
      .enum(["textbox", "combobox", "checkbox", "radio", "button", "any", "value"])
      .optional(),
  }),
  /** Visible text of the element itself (links, buttons, cells). */
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    tag: z.string().optional(),
    exact: z.boolean().optional(),
  }),
  /** Stable HTML attributes (form field `name`, `type`, `value`, `href`). */
  z.object({
    kind: z.literal("attr"),
    tag: z.string().optional(),
    attrs: z.record(z.string(), z.string()),
  }),
  /**
   * Table-relational locator: "the {column} cell of the row whose {row.column} equals {row.equals}
   * in the table with these headers". Essential for legacy table-driven screens where the
   * cell's own text is the value we want (and therefore cannot be used to find it).
   */
  z.object({
    kind: z.literal("table"),
    headers: z.array(z.string()).min(1),
    row: z.object({ column: z.string(), equals: z.string() }).optional(),
    rowIndex: z.number().int().nonnegative().optional(),
    column: z.string(),
    inner: z.enum(["cell", "link", "control"]).optional(),
  }),
  /** Structural fallbacks — brittle, recorded for completeness and drift diagnosis. */
  z.object({ kind: z.literal("css"), selector: z.string() }),
  z.object({ kind: z.literal("xpath"), expression: z.string() }),
  /**
   * Visual fallback: a small PNG crop of the control + where it was. Resolved by template
   * matching on a screenshot; this is the strategy a screenshot-only (desktop) surface would use.
   */
  z.object({
    kind: z.literal("visual"),
    bbox: BBox,
    template: z.string(),
    threshold: z.number().min(0).max(1).optional(),
  }),
]);
export type TargetStrategy = z.infer<typeof TargetStrategy>;
export type TargetStrategyKind = TargetStrategy["kind"];

export const Target = z.object({
  /** Human-readable, e.g. `the "Member Number" text box`. */
  description: z.string(),
  /** Frame name path from the top document, e.g. ["main"]. Empty = top document. */
  frame: z.array(z.string()).default([]),
  strategies: z.array(TargetStrategy).min(1),
  /** What the control looked like when recorded — used for drift diagnosis only. */
  recorded: z
    .object({
      tag: z.string(),
      role: z.string().optional(),
      name: z.string().optional(),
      bbox: BBox.optional(),
    })
    .optional(),
});
export type Target = z.infer<typeof Target>;

// ---------------------------------------------------------------------------
// Expectations: assertions / detectors
// ---------------------------------------------------------------------------

const SimpleExpectation = z.discriminatedUnion("kind", [
  /** Regex (or template with {{params}}) tested against the frame's URL. */
  z.object({ kind: z.literal("url"), pattern: z.string(), frame: z.array(z.string()).optional() }),
  /** Visible text present (or absent) in a frame. */
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    frame: z.array(z.string()).optional(),
    present: z.boolean().optional(),
    regex: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("title"), pattern: z.string() }),
  z.object({
    kind: z.literal("target"),
    target: Target,
    state: z.enum(["visible", "hidden", "enabled"]),
  }),
  /** Main-document HTTP status of the last navigation. */
  z.object({
    kind: z.literal("http_status"),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  /** A JS dialog (alert/confirm/prompt) was raised during the last action. */
  z.object({ kind: z.literal("dialog"), messagePattern: z.string().optional() }),
]);
export type SimpleExpectation = z.infer<typeof SimpleExpectation>;

export const Expectation = z.union([
  SimpleExpectation,
  z.object({ kind: z.literal("all"), of: z.array(SimpleExpectation).min(1) }),
  z.object({ kind: z.literal("any"), of: z.array(SimpleExpectation).min(1) }),
]);
export type Expectation = z.infer<typeof Expectation>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const RiskClass = z.enum(["safe", "mutating", "irreversible"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const Parser = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("number") }),
  z.object({ type: z.literal("currency") }),
  z.object({ type: z.literal("boolean"), truthy: z.array(z.string()).optional() }),
  z.object({ type: z.literal("regex"), pattern: z.string(), group: z.number().int().optional() }),
]);
export type Parser = z.infer<typeof Parser>;

export const DialogPolicy = z.object({
  messagePattern: z.string(),
  response: z.enum(["accept", "dismiss"]),
});

const stepBase = {
  id: z.string(),
  name: z.string(),
  /** Why the recorder took this step (redacted model rationale). */
  intent: z.string().optional(),
  risk: RiskClass.default("safe"),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Pre-conditions: what the screen must show BEFORE the action is taken (derived from the
   * observation the recorder acted on). Replay refuses to act blindly on the wrong screen.
   */
  precondition: z.array(Expectation).default([]),
  /** Post-conditions verified after the action. */
  expect: z.array(Expectation).default([]),
  onFailure: z.enum(["fail", "escalate", "skip"]).optional(),
  /** A JS dialog this step is EXPECTED to raise, and how to answer it. Any other dialog is a condition. */
  dialog: DialogPolicy.optional(),
};

export const Step = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: ValueRef, ...stepBase }),
  z.object({ kind: z.literal("click"), target: Target, ...stepBase }),
  z.object({
    kind: z.literal("type"),
    target: Target,
    value: ValueRef,
    clear: z.boolean().optional(),
    pressEnter: z.boolean().optional(),
    ...stepBase,
  }),
  z.object({ kind: z.literal("select"), target: Target, value: ValueRef, ...stepBase }),
  z.object({ kind: z.literal("press"), key: z.string(), ...stepBase }),
  z.object({
    kind: z.literal("extract"),
    target: Target,
    output: z.string(),
    parse: Parser.default({ type: "text" }),
    ...stepBase,
  }),
  /** Pure checkpoint: `expect` must hold. */
  z.object({ kind: z.literal("assert"), ...stepBase }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().positive().optional(), ...stepBase }),
]);
export type Step = z.infer<typeof Step>;
export type StepKind = Step["kind"];

// ---------------------------------------------------------------------------
// Conditions: the runtime error taxonomy
// ---------------------------------------------------------------------------

export const ConditionClass = z.enum(["business_outcome", "recoverable", "hard_failure"]);
export type ConditionClass = z.infer<typeof ConditionClass>;

export const Handler = z.discriminatedUnion("kind", [
  /** Click a known control (e.g. "Continue" on an interstitial), then retry or continue. */
  z.object({
    kind: z.literal("dismiss"),
    target: Target,
    then: z.enum(["retry_step", "continue"]).default("retry_step"),
  }),
  /** Transient state: wait, then restart the flow from its entry (default) or retry the step. */
  z.object({
    kind: z.literal("wait_retry"),
    waitMs: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    then: z.enum(["restart", "retry_step"]).default("restart"),
  }),
  /** Re-run the app profile's login flow, then restart the capability or retry the step. */
  z.object({ kind: z.literal("reauthenticate"), then: z.enum(["restart", "retry_step"]) }),
  z.object({ kind: z.literal("escalate"), reason: z.string().optional() }),
]);
export type Handler = z.infer<typeof Handler>;

export const OutcomeExtract = z.object({
  name: z.string(),
  target: Target,
  parse: Parser.default({ type: "text" }),
});

export const Condition = z.object({
  id: z.string(),
  description: z.string(),
  detect: Expectation,
  class: ConditionClass,
  /** business_outcome: what the caller receives. */
  outcome: z
    .object({
      code: z.string(),
      message: z.string(),
      extract: z.array(OutcomeExtract).optional(),
    })
    .optional(),
  /** recoverable: what replay does about it. */
  handler: Handler.optional(),
  /** hard_failure: the failure code reported. */
  failureCode: z.string().optional(),
  /** Restrict detection to particular steps (default: checked at every step). */
  stepIds: z.array(z.string()).optional(),
  /**
   * May the handler run automatically after a mutating/irreversible step has already
   * executed in this run? Default false: replay escalates instead of risking a double post.
   */
  safeAfterMutation: z.boolean().optional(),
  origin: z.enum(["profile", "discovery", "probe", "authored", "human"]),
});
export type Condition = z.infer<typeof Condition>;

// ---------------------------------------------------------------------------
// Contract: inputs / outputs / policy
// ---------------------------------------------------------------------------

export const Sensitivity = z.enum(["none", "pii", "financial", "secret"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ParamSpec = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  example: z.string().optional(),
  default: z.string().optional(),
  sensitivity: Sensitivity.default("none"),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  sensitivity: Sensitivity.default("none"),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

export const CapabilityPolicy = z.object({
  riskClass: RiskClass,
  sideEffects: z.enum(["none", "creates_record", "modifies_record", "moves_money"]),
  /** Unattended replay of risky steps requires an explicit approval on the invocation. */
  requiresApproval: z.boolean(),
  /** Origins the replay may touch; enforced by the policy gate on every action. */
  allowedOrigins: z.array(z.string()),
});

export const TenantOverride = z.object({
  steps: z
    .record(
      z.string(),
      z.object({
        target: Target.optional(),
        value: ValueRef.optional(),
        expect: z.array(Expectation).optional(),
        skip: z.boolean().optional(),
      }),
    )
    .default({}),
  conditions: z.array(Condition).default([]),
  checkpoint: z.array(Expectation).optional(),
});
export type TenantOverride = z.infer<typeof TenantOverride>;

export const Provenance = z.object({
  recordedAt: z.string(),
  recordedBy: z.object({
    kind: z.enum(["llm", "scripted", "human"]),
    model: z.string().optional(),
  }),
  discoveryRunId: z.string(),
  tenant: z.string(),
  tools: z.record(z.string(), z.string()).default({}),
  /** Path to the redacted transcript in evidence — the transcript is NOT part of the artifact. */
  transcriptRef: z.string().optional(),
  /** Result of the verification replay run right after recording (model-free). */
  verification: z
    .object({
      status: z.enum(["passed", "failed", "skipped"]),
      runId: z.string().optional(),
      at: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  /** Lineage: the artifact id/version this one was derived from (override promotion, re-record). */
  derivedFrom: z.object({ id: z.string(), version: z.string(), reason: z.string() }).optional(),
});

export const Stats = z.object({
  replays: z.number().int().default(0),
  successes: z.number().int().default(0),
  businessOutcomes: z.number().int().default(0),
  failures: z.number().int().default(0),
  lastReplayAt: z.string().optional(),
  /** successes / replays over the recorded window; drives the approval gate suggestion. */
  stabilityScore: z.number().min(0).max(1).optional(),
});

export const Capability = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  /** Dotted, agent-friendly name: `member.lookup_savings_balance`. */
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.enum(["draft", "approved", "deprecated"]),
  title: z.string(),
  description: z.string(),
  /** The natural-language goal the capability was discovered from. */
  goal: z.string(),
  app: z.object({
    /** App profile id (shared conditions, login flow, settle policy). */
    profile: z.string(),
    surface: z.enum(["web", "legacy_web", "desktop"]),
    /** Vendor product family the artifact is valid for, independent of tenant. */
    family: z.string(),
  }),
  entry: z.object({
    url: ValueRef,
    requiresSession: z.boolean().default(true),
  }),
  inputs: z.record(z.string(), ParamSpec),
  outputs: z.record(z.string(), OutputSpec),
  policy: CapabilityPolicy,
  steps: z.array(Step).min(1),
  checkpoint: z.object({ description: z.string(), expect: z.array(Expectation).min(1) }),
  conditions: z.array(Condition).default([]),
  /** Per-tenant specialisations; the base artifact stays shared. */
  overrides: z.record(z.string(), TenantOverride).default({}),
  provenance: Provenance,
  review: z
    .object({
      approvedBy: z.string().optional(),
      approvedAt: z.string().optional(),
      /** Content hash the approval was given for; any later edit silently demotes to draft. */
      approvedHash: z.string().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  /**
   * Tamper evidence: sha256 over the canonical artifact without integrity/review/stats/status.
   * Computed on save; `cua validate` and replay verify it.
   */
  integrity: z.object({ algorithm: z.literal("sha256"), hash: z.string() }).optional(),
  stats: Stats.default({ replays: 0, successes: 0, businessOutcomes: 0, failures: 0 }),
});
export type Capability = z.infer<typeof Capability>;
export type CapabilityInput = z.input<typeof Capability>;

// ---------------------------------------------------------------------------
// App profile and tenant binding (shared across capabilities)
// ---------------------------------------------------------------------------

export const AppProfile = z.object({
  id: z.string(),
  displayName: z.string(),
  family: z.string(),
  surface: z.enum(["web", "legacy_web", "desktop"]),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).default({
    width: 1280,
    height: 800,
  }),
  /** Which frame path holds the page content (for URL expectations and landmarks). */
  contentFrame: z.array(z.string()).default([]),
  session: z.object({
    login: z.object({
      entry: ValueRef,
      steps: z.array(Step),
      authenticated: Expectation,
    }),
    /** How an expired/lost session presents itself. */
    expired: Expectation,
  }),
  /** Conditions shared by every capability on this app (session expiry, app errors, interstitials). */
  conditions: z.array(Condition).default([]),
  settle: z
    .object({
      domQuietMs: z.number().int().default(300),
      maxMs: z.number().int().default(8000),
    })
    .default({ domQuietMs: 300, maxMs: 8000 }),
  defaultStepTimeoutMs: z.number().int().default(10000),
  /**
   * Data classification for this app: controls/cells whose label or column header matches
   * are masked in every screenshot and hidden from the model's element list.
   */
  dataPolicy: z
    .object({
      maskLabels: z.array(z.string()).default([]),
      maskNamePatterns: z.array(z.string()).default([]),
    })
    .prefault({}),
  /**
   * Which locator strategies this surface can execute, in preference order. A desktop
   * profile would list role and visual only; the web default allows everything.
   */
  locatorPolicy: z
    .object({
      allow: z
        .array(z.enum(["role", "label", "text", "table", "attr", "css", "xpath", "visual"]))
        .default(["role", "label", "text", "table", "attr", "css", "xpath", "visual"]),
    })
    .prefault({}),
});
export type AppProfile = z.infer<typeof AppProfile>;

export const TenantBinding = z.object({
  id: z.string(),
  displayName: z.string(),
  profile: z.string(),
  baseUrl: z.string(),
  /** Free-form variant tag (vendor version, branding) for drift bookkeeping. */
  variant: z.string().optional(),
  /** Tenant-level params available to templates, e.g. base_url. */
  params: z.record(z.string(), z.string()).default({}),
  /** Secret refs → "env:VAR_NAME" (or a vault URI in production). Values never enter artifacts/logs. */
  secrets: z.record(z.string(), z.string()).default({}),
});
export type TenantBinding = z.infer<typeof TenantBinding>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseCapability(json: unknown): Capability {
  return Capability.parse(json);
}

/** JSON Schema for reviewers / agent tooling (generated from the Zod source of truth). */
export function capabilityJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Capability, { target: "draft-7", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}

export function isTargetStep(step: Step): step is Extract<Step, { target: Target }> {
  return "target" in step;
}

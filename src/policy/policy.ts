/**
 * Safety policy: a single choke point evaluated before EVERY action in both discovery and
 * replay. Nothing touches the surface without a Decision from the gate.
 */
import { z } from "zod";
import type { RiskClass } from "../core/schema.js";

export const ActionKind = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "extract",
  "scroll",
  "wait",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const PolicyConfig = z.object({
  allow: z.object({
    origins: z.array(z.string()).min(1),
    pathPatterns: z.array(z.string()).default([".*"]),
    actions: z.array(ActionKind).default([...ActionKind.options]),
  }),
  deny: z
    .object({
      pathPatterns: z.array(z.string()).default([]),
    })
    .default({ pathPatterns: [] }),
  risk: z
    .object({
      /** Control names that indicate an irreversible business action. */
      irreversiblePatterns: z
        .array(z.string())
        .default([
          "\\bconfirm\\b",
          "\\bpost\\b",
          "\\bsubmit\\b",
          "\\bapprove\\b",
          "\\btransfer\\b",
          "\\bclose account\\b",
          "\\bdelete\\b",
          "\\bpay\\b",
        ]),
      /** Control names that mutate state but are reviewable/reversible before commit. */
      mutatingPatterns: z
        .array(z.string())
        .default([
          "\\bsave\\b",
          "\\bupdate\\b",
          "\\bcreate\\b",
          "\\badd\\b",
          "\\bapply\\b",
          "\\bremove\\b",
        ]),
    })
    .prefault({}),
  modes: z
    .object({
      /** What discovery does with mutating/irreversible actions. */
      discovery: z.enum(["confirm", "block", "allow"]).default("confirm"),
      /**
       * approved_only: risky steps run unattended only when the artifact is approved AND the
       * invocation carries an explicit approval; otherwise the run pauses for a human.
       */
      replay: z.enum(["approved_only", "confirm", "block", "allow"]).default("approved_only"),
    })
    .prefault({}),
  escalation: z
    .object({
      onHardFailure: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(600_000),
      console: z.object({ port: z.number().int().default(4790) }).default({ port: 4790 }),
    })
    .prefault({}),
  data: z
    .object({
      screenshots: z.enum(["masked", "full", "none"]).default("masked"),
      redactPatterns: z.array(z.object({ label: z.string(), pattern: z.string() })).default([]),
    })
    .prefault({}),
  limits: z
    .object({
      maxSteps: z.number().int().positive().default(30),
      maxRunMs: z.number().int().positive().default(600_000),
      stepTimeoutMs: z.number().int().positive().default(10_000),
    })
    .prefault({}),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export interface ProposedAction {
  kind: ActionKind;
  /** URL of the frame the action happens in (or the navigation target). */
  url: string;
  /** Accessible name / label / text of the control, if any. */
  controlName?: string;
  controlRole?: string;
  /** Labels of submit buttons in the control's form (for Enter-key submissions). */
  formSubmitLabels?: string[];
  pressEnter?: boolean;
  /** Risk class already recorded on the artifact step (replay). */
  declaredRisk?: RiskClass;
}

export interface PolicyContext {
  mode: "discovery" | "replay";
  artifactStatus?: "draft" | "approved" | "deprecated";
  /** Caller supplied an explicit approval for risky steps on this invocation. */
  invocationApproved?: boolean;
}

export type Decision =
  | { verdict: "allow"; risk: RiskClass; rule: string }
  | { verdict: "confirm"; risk: RiskClass; rule: string; reason: string }
  | { verdict: "deny"; risk: RiskClass; rule: string; reason: string };

const RISK_ORDER: Record<RiskClass, number> = { safe: 0, mutating: 1, irreversible: 2 };
export function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export class PolicyGate {
  private readonly irreversible: RegExp[];
  private readonly mutating: RegExp[];
  private readonly allowPaths: RegExp[];
  private readonly denyPaths: RegExp[];

  constructor(public readonly config: PolicyConfig) {
    this.irreversible = config.risk.irreversiblePatterns.map((p) => new RegExp(p, "i"));
    this.mutating = config.risk.mutatingPatterns.map((p) => new RegExp(p, "i"));
    this.allowPaths = config.allow.pathPatterns.map((p) => new RegExp(p));
    this.denyPaths = config.deny.pathPatterns.map((p) => new RegExp(p));
  }

  /** Classify by what a human operator would consider the action to *mean*. */
  classifyRisk(a: ProposedAction): RiskClass {
    let risk: RiskClass = a.declaredRisk ?? "safe";
    const names: string[] = [];
    if (a.kind === "click" && a.controlName) names.push(a.controlName);
    if ((a.kind === "type" || a.kind === "press") && a.pressEnter)
      names.push(...(a.formSubmitLabels ?? []));
    if (a.kind === "press" && a.formSubmitLabels) names.push(...a.formSubmitLabels);
    for (const n of names) {
      if (this.irreversible.some((re) => re.test(n))) risk = maxRisk(risk, "irreversible");
      else if (this.mutating.some((re) => re.test(n))) risk = maxRisk(risk, "mutating");
    }
    return risk;
  }

  isUrlAllowed(url: string): { ok: boolean; reason?: string } {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return url === "about:blank" ? { ok: true } : { ok: false, reason: `unparseable url ${url}` };
    }
    if (u.protocol === "javascript:") return { ok: false, reason: "javascript: navigation" };
    if (!this.config.allow.origins.includes(u.origin)) {
      return { ok: false, reason: `origin ${u.origin} not in allowlist` };
    }
    const path = u.pathname + u.search;
    if (this.denyPaths.some((re) => re.test(path)))
      return { ok: false, reason: `path ${path} is denied` };
    if (!this.allowPaths.some((re) => re.test(path)))
      return { ok: false, reason: `path ${path} not allowed` };
    return { ok: true };
  }

  evaluate(a: ProposedAction, ctx: PolicyContext): Decision {
    const risk = this.classifyRisk(a);
    if (!this.config.allow.actions.includes(a.kind)) {
      return {
        verdict: "deny",
        risk,
        rule: "allow.actions",
        reason: `action ${a.kind} not allowed`,
      };
    }
    const urlCheck = this.isUrlAllowed(a.url);
    if (!urlCheck.ok) {
      return { verdict: "deny", risk, rule: "allow.origins", reason: urlCheck.reason! };
    }
    if (risk === "safe") return { verdict: "allow", risk, rule: "risk.safe" };

    const why = `${risk} action "${a.controlName ?? a.kind}"`;
    if (ctx.mode === "discovery") {
      switch (this.config.modes.discovery) {
        case "allow":
          return { verdict: "allow", risk, rule: "modes.discovery=allow" };
        case "block":
          return { verdict: "deny", risk, rule: "modes.discovery=block", reason: why };
        case "confirm":
          return { verdict: "confirm", risk, rule: "modes.discovery=confirm", reason: why };
      }
    }
    switch (this.config.modes.replay) {
      case "allow":
        return { verdict: "allow", risk, rule: "modes.replay=allow" };
      case "block":
        return { verdict: "deny", risk, rule: "modes.replay=block", reason: why };
      case "confirm":
        return { verdict: "confirm", risk, rule: "modes.replay=confirm", reason: why };
      case "approved_only":
        if (ctx.artifactStatus === "approved" && ctx.invocationApproved) {
          return {
            verdict: "allow",
            risk,
            rule: "modes.replay=approved_only (approved artifact + invocation approval)",
          };
        }
        return {
          verdict: "confirm",
          risk,
          rule: "modes.replay=approved_only",
          reason:
            ctx.artifactStatus !== "approved"
              ? `${why} on a ${ctx.artifactStatus ?? "draft"} artifact requires a human`
              : `${why} without an invocation approval requires a human`,
        };
    }
  }
}

export const DEFAULT_POLICY: PolicyConfig = PolicyConfig.parse({
  allow: { origins: ["http://localhost:4173", "http://127.0.0.1:4173"] },
  deny: { pathPatterns: ["^/__chaos", "^/__reset"] },
});

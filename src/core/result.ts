/**
 * Result contract returned to the caller (an AI agent or a human) after a run.
 *
 * Exactly three terminal statuses:
 *   success          — checkpoint verified, declared outputs returned.
 *   business_outcome — the application answered with a legitimate, expected result that is
 *                      not the happy path ("no such member", "validation error", "permission
 *                      denied"). Not a crash; the caller must handle it.
 *   failure          — the run could not complete; carries a debuggable error (what step, what
 *                      was expected, what was observed, and evidence paths).
 *
 * Recoverable conditions never terminate a run; they are reported in `recoveries`.
 * Human interventions are reported in `interventions` regardless of the final status.
 */
import type { TargetStrategyKind, StepKind, Target } from "./schema.js";

export const FailureCodes = [
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "EXPECTATION_FAILED",
  "CHECKPOINT_FAILED",
  "TIMEOUT",
  "APP_ERROR",
  "UNEXPECTED_DIALOG",
  "NAVIGATION_ERROR",
  "POLICY_BLOCKED",
  "SESSION_LOST",
  "SURFACE_ERROR",
  "UNKNOWN_STATE",
  "HUMAN_ABORTED",
  "ESCALATION_TIMEOUT",
  "ESCALATION_UNAVAILABLE",
  "INVALID_INPUT",
  "MAX_STEPS",
  "AGENT_GAVE_UP",
  "LLM_ERROR",
  "OUTPUT_PARSE_ERROR",
] as const;
export type FailureCode = (typeof FailureCodes)[number];

export interface RunError {
  code: FailureCode;
  message: string;
  stepId?: string;
  stepIndex?: number;
  stepName?: string;
  expected?: string;
  observed?: string;
  /** Paths (relative to the evidence dir) of screenshots / DOM snapshots / traces. */
  evidence: string[];
  cause?: string;
}

export interface Resolution {
  strategy: TargetStrategyKind | "ref" | "point";
  /** 0 = first (most robust) strategy; higher tiers indicate drift. */
  tier: number;
  matches: number;
  ms: number;
}

export interface ConditionHit {
  conditionId: string;
  class: "business_outcome" | "recoverable" | "hard_failure";
  description: string;
  handled: "resolved" | "escalated" | "terminal" | "failed";
  handler?: string;
  attempt?: number;
  stepId?: string;
}

export interface StepReport {
  stepId: string;
  index: number;
  kind: StepKind;
  name: string;
  status: "ok" | "skipped" | "failed" | "recovered";
  startedAt: string;
  durationMs: number;
  attempts: number;
  resolution?: Resolution;
  recoveries: ConditionHit[];
  dialog?: { message: string; type: string; response: "accept" | "dismiss" };
  screenshot?: string;
  extracted?: { output: string; raw: string };
  error?: RunError;
  /** Set when a tenant override replaced part of this step. */
  overridden?: string[];
  /**
   * When the target resolved through a fallback tier, a fresh multi-strategy descriptor of
   * the element actually used — a candidate tenant override for a reviewer to promote.
   */
  proposedOverride?: { target: Target; resolvedVia: string };
}

export interface InterventionSummary {
  id: string;
  type: "stuck" | "approval" | "failure" | "agent_request";
  reason: string;
  raisedAt: string;
  resolvedAt?: string;
  resolution?: "resume" | "retry" | "skip" | "abort" | "approve" | "deny";
  operator?: string;
  humanActions: number;
  controlTransfers: number;
  note?: string;
}

export interface DriftReport {
  /** Histogram of which strategy tier resolved targets: {"0": 7, "2": 1}. */
  tierHistogram: Record<string, number>;
  warnings: string[];
}

export interface RunResultBase {
  runId: string;
  kind: "replay" | "discovery";
  capability: { name: string; version: string; id: string };
  tenant: string;
  /** Inputs as received, with sensitive values masked. */
  inputs: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  steps: StepReport[];
  recoveries: ConditionHit[];
  interventions: InterventionSummary[];
  drift: DriftReport;
  evidence: { dir: string; events: string; trace?: string; failureScreenshot?: string };
  /** Which policy decisions were made (allow/deny/confirm) — summarised. */
  policy: { decisions: number; denied: number; confirmations: number };
}

export interface SuccessResult extends RunResultBase {
  status: "success";
  outputs: Record<string, string | number | boolean | null>;
}

export interface BusinessOutcomeResult extends RunResultBase {
  status: "business_outcome";
  outcome: { code: string; message: string; conditionId: string; data?: Record<string, unknown> };
}

export interface FailureResult extends RunResultBase {
  status: "failure";
  error: RunError;
}

export type RunResult = SuccessResult | BusinessOutcomeResult | FailureResult;

export function isSuccess(r: RunResult): r is SuccessResult {
  return r.status === "success";
}

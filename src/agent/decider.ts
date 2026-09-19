/**
 * The decision seam of the discovery loop. The loop owns observation, policy, acting and
 * recording; a Decider only chooses the next action(s). Two implementations:
 *   - LlmDecider      (Claude, real computer use)
 *   - ScriptedDecider (deterministic, for offline tests and demos without model access)
 */
import type { Observation } from "../surface/types.js";
import type { EventSink } from "../core/events.js";
import type { Step } from "../core/schema.js";
import { z } from "zod";

export type AgentAction =
  | { id: string; tool: "click"; ref: string; why: string; accept_dialog?: boolean }
  | { id: string; tool: "type"; ref: string; text: string; why: string; press_enter?: boolean }
  | { id: string; tool: "type_secret"; ref: string; secret: string; why: string }
  | { id: string; tool: "select"; ref: string; value: string; why: string }
  | { id: string; tool: "press"; key: string; why: string }
  | { id: string; tool: "navigate"; url: string; why: string }
  | {
      id: string;
      tool: "extract";
      ref: string;
      output: string;
      why: string;
      parse?: "text" | "number" | "currency";
    }
  | { id: string; tool: "wait"; seconds: number; why: string }
  | { id: string; tool: "done"; summary: string; evidence_ref: string }
  | { id: string; tool: "request_human"; reason: string }
  | {
      id: string;
      tool: "give_up";
      reason: string;
      kind: "business_outcome" | "impossible" | "unsafe";
    };

export interface ActionResult {
  id: string;
  text: string;
  isError?: boolean;
}

export interface TaskSpec {
  goal: string;
  /** Parameter values the agent should use, e.g. { member_id: "10023" }. */
  inputs: Record<string, string>;
  app: string;
  tenant: string;
  secretRefs: string[];
  maxSteps: number;
}

export interface DecisionInput {
  observation: Observation;
  /** Results of the previous turn's actions (empty on the first turn). */
  results: ActionResult[];
  /** Optional out-of-band note (e.g. a human operator intervened). */
  note?: string;
  stepNumber: number;
  /** Evidence-relative path of the screenshot shown to the model (for the transcript). */
  screenshotRef?: string;
}

export const ContractProposal = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  title: z.string(),
  description: z.string(),
  inputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number", "integer", "boolean"]),
      description: z.string(),
      sensitivity: z.enum(["none", "pii", "financial", "secret"]),
      pattern: z.string().nullable(),
    }),
  ),
  outputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number", "boolean"]),
      description: z.string(),
      sensitivity: z.enum(["none", "pii", "financial", "secret"]),
    }),
  ),
  checkpointDescription: z.string(),
  sideEffects: z.enum(["none", "creates_record", "modifies_record", "moves_money"]),
});
export type ContractProposal = z.infer<typeof ContractProposal>;

export const ConditionProposal = z.object({
  class: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  /** SCREAMING_SNAKE code for business outcomes / failures, e.g. MEMBER_NOT_FOUND. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  /** Caller-facing message. */
  message: z.string(),
  /** Exact on-screen text that identifies this state (short, stable; no record-specific values). */
  detectorText: z.string().min(3),
  /** For recoverable states: ref of the control that dismisses it, else null. */
  dismissRef: z.string().nullable(),
});
export type ConditionProposal = z.infer<typeof ConditionProposal>;

export interface FinalizeInput {
  goal: string;
  inputs: Record<string, string>;
  steps: Step[];
  outputs: Array<{ name: string; sample: unknown; parse: string }>;
  app: string;
  suggestedName?: string;
}

export interface ClassifyInput {
  goal: string;
  inputs: Record<string, string>;
  observation: Observation;
  failure: { code: string; message: string; stepName?: string };
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
}

export interface Decider {
  readonly kind: "llm" | "scripted";
  readonly model: string;
  start(task: TaskSpec, events: EventSink): Promise<void>;
  decide(input: DecisionInput): Promise<AgentAction[]>;
  finalize(input: FinalizeInput): Promise<ContractProposal>;
  classify(input: ClassifyInput): Promise<ConditionProposal>;
  /** Redacted, image-free transcript for evidence. */
  transcript(): unknown;
  usage(): LlmUsage;
}

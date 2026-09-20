/**
 * Structured run events — the "what the system did and why" log.
 * Every event is one JSON line in evidence/<run>/events.jsonl, already redacted.
 */
export type EventType =
  | "run.start"
  | "run.end"
  | "session.bootstrap"
  | "step.start"
  | "step.resolve"
  | "step.act"
  | "step.expect"
  | "step.end"
  | "step.extract"
  | "condition.detected"
  | "condition.handled"
  | "condition.proposed"
  | "assist.requested"
  | "assist.applied"
  | "ledger"
  | "integrity"
  | "policy.decision"
  | "dialog"
  | "agent.observe"
  | "agent.decide"
  | "agent.act"
  | "agent.finalize"
  | "agent.llm"
  | "recorder.step"
  | "intervention.raised"
  | "intervention.resolved"
  | "control.transfer"
  | "human.action"
  | "evidence.captured"
  | "drift.warning"
  | "error";

export interface RunEvent {
  ts: string;
  seq: number;
  runId: string;
  type: EventType;
  /** Short human-readable line. */
  msg: string;
  data?: Record<string, unknown>;
}

export interface EventSink {
  emit(type: EventType, msg: string, data?: Record<string, unknown>): void;
}

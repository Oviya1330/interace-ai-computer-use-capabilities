import type { FailureCode } from "./result.js";

/** Thrown inside the engines; converted into a RunError at the boundary. */
export class RunFailure extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly detail: { expected?: string; observed?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "RunFailure";
  }
}

export class PolicyViolation extends Error {
  constructor(
    message: string,
    public readonly rule: string,
  ) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Raised inside the engine when the run must end with a *business outcome* rather than a
 * failure (e.g. a duplicate invocation detected by the idempotency ledger).
 */
export class BusinessOutcomeSignal extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BusinessOutcomeSignal";
  }
}

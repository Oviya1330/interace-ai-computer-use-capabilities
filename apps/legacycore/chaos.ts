/**
 * Test-only fault injection. `POST /__chaos` arms a scenario that applies to the next N
 * tenant page requests whose path matches `pathPattern`. This exists so replays can be
 * exercised against the runtime conditions the brief cares about (timeouts, slowness,
 * app errors, interstitials) without touching production-like code paths.
 */

export const CHAOS_SCENARIOS = [
  "none",
  "session_expired",
  "slow",
  "app_error",
  "maintenance_notice",
  "security_bulletin",
] as const;

export type ChaosScenario = (typeof CHAOS_SCENARIOS)[number];

export interface ChaosState {
  scenario: ChaosScenario;
  remaining: number;
  delayMs: number;
  pathPattern: string;
  fired: number;
}

const DEFAULT_STATE: ChaosState = {
  scenario: "none",
  remaining: 0,
  delayMs: 6000,
  pathPattern: ".*",
  fired: 0,
};

export class ChaosError extends Error {}

export class ChaosController {
  private state: ChaosState = { ...DEFAULT_STATE };
  private pattern: RegExp = /.*/;

  status(): ChaosState {
    return { ...this.state };
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
    this.pattern = /.*/;
  }

  arm(input: unknown): ChaosState {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const scenario = body.scenario;
    if (
      typeof scenario !== "string" ||
      !(CHAOS_SCENARIOS as readonly string[]).includes(scenario)
    ) {
      throw new ChaosError(`scenario must be one of: ${CHAOS_SCENARIOS.join(", ")}`);
    }
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 0)
      throw new ChaosError("count must be a non-negative integer");
    const delayMs = body.delayMs === undefined ? 6000 : Number(body.delayMs);
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new ChaosError("delayMs must be a non-negative number");
    const pathPattern = body.pathPattern === undefined ? ".*" : String(body.pathPattern);
    let pattern: RegExp;
    try {
      pattern = new RegExp(pathPattern);
    } catch {
      throw new ChaosError("pathPattern must be a valid regular expression");
    }
    this.pattern = pattern;
    this.state = {
      scenario: scenario as ChaosScenario,
      remaining: scenario === "none" ? 0 : count,
      delayMs,
      pathPattern,
      fired: 0,
    };
    return this.status();
  }

  /** Consumes one charge if the armed scenario applies to `path`; returns the scenario or null. */
  consume(path: string): Exclude<ChaosScenario, "none"> | null {
    if (this.state.scenario === "none" || this.state.remaining <= 0) return null;
    if (!this.pattern.test(path)) return null;
    this.state.remaining -= 1;
    this.state.fired += 1;
    return this.state.scenario;
  }

  get delayMs(): number {
    return this.state.delayMs;
  }
}

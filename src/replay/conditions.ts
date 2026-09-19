import type { Condition } from "../core/schema.js";
import type { Params } from "../core/template.js";
import type { Surface } from "../surface/types.js";

export interface Detected {
  condition: Condition;
  observed: string;
}

/**
 * Evaluate the condition detectors against the current surface state, in declaration order.
 * Capability-level conditions come first (more specific), then profile-level ones.
 */
export async function detectCondition(
  conditions: Condition[],
  surface: Surface,
  params: Params,
  stepId?: string,
): Promise<Detected | null> {
  for (const c of conditions) {
    if (c.stepIds && stepId && !c.stepIds.includes(stepId)) continue;
    const r = await surface.check(c.detect, params, { timeoutMs: 0 });
    if (r.ok) return { condition: c, observed: r.observed };
  }
  return null;
}

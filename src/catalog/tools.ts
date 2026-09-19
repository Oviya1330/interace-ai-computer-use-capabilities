/**
 * Agent-facing capability interface: each approved artifact becomes a tool definition an
 * AI agent can call by name with typed arguments. Replay is the implementation.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Capability } from "../core/schema.js";

export function capabilityToTool(cap: Capability): Anthropic.Tool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(cap.inputs)) {
    properties[name] = {
      type: spec.type === "integer" ? "integer" : spec.type,
      description: `${spec.description}${spec.example ? ` (e.g. ${spec.example})` : ""}`,
      ...(spec.pattern ? { pattern: spec.pattern } : {}),
      ...(spec.enum ? { enum: spec.enum } : {}),
    };
    if (spec.required) required.push(name);
  }
  const outputs = Object.entries(cap.outputs)
    .map(([n, s]) => `${n} (${s.type}): ${s.description}`)
    .join("; ");
  return {
    name: cap.name.replace(/\./g, "__"),
    description: `${cap.title}. ${cap.description} Returns: ${outputs || "no outputs"}. Side effects: ${cap.policy.sideEffects}; risk: ${cap.policy.riskClass}${cap.policy.requiresApproval ? " (requires approval)" : ""}. Possible business outcomes: ${
      cap.conditions
        .filter((c) => c.class === "business_outcome")
        .map((c) => c.outcome?.code)
        .filter(Boolean)
        .join(", ") || "none recorded"
    }.`,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

export function toolNameToCapability(name: string): string {
  return name.replace(/__/g, ".");
}

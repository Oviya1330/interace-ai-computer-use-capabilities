/**
 * An AI agent discovering and invoking a capability by name with typed args.
 * The catalog is exposed as tools; the tool implementation is a deterministic replay through
 * the capability API (`cua serve`). Requires ANTHROPIC_API_KEY and a running `cua serve`.
 *
 *   npm run app            # terminal 1: mock LegacyCore
 *   npx cua serve          # terminal 2: capability API on :4780
 *   npx tsx examples/agent-invokes-capability.ts "What is member 10023's savings balance?"
 */
import Anthropic from "@anthropic-ai/sdk";
import { toolNameToCapability } from "../src/catalog/tools.js";

const API = process.env.CUA_API ?? "http://127.0.0.1:4780";
const question = process.argv[2] ?? "What is the current savings balance of member 10023?";

async function main(): Promise<void> {
  const catalog = (await fetch(`${API}/capabilities`).then((r) => r.json())) as {
    tools: Anthropic.Tool[];
  };
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  for (;;) {
    const res = await client.beta.messages.create({
      model: process.env.CUA_MODEL ?? "claude-opus-5",
      max_tokens: 4096,
      system:
        "You are a credit-union servicing agent. Use the available capabilities to act on the core system; never guess values. Report business outcomes (e.g. member not found) plainly.",
      tools: catalog.tools,
      messages,
      betas: ["server-side-fallback-2026-07-01"],
      ...({ fallbacks: "default" } as Record<string, unknown>),
    });
    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlock[] });
    const uses = res.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (uses.length === 0 || res.stop_reason !== "tool_use") {
      console.log(
        res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      );
      return;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const name = toolNameToCapability(u.name);
      console.error(`→ invoking ${name} with ${JSON.stringify(u.input)}`);
      const r = await fetch(`${API}/capabilities/${name}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The idempotency key makes a retried tool call safe: an irreversible step never posts twice.
        body: JSON.stringify({
          tenant: "summit",
          inputs: u.input,
          requestedBy: "agent:servicing-assistant",
          idempotencyKey: `${u.id}`,
        }),
      });
      const body = (await r.json()) as {
        status: string;
        outputs?: unknown;
        outcome?: unknown;
        error?: unknown;
      };
      const summary =
        body.status === "success"
          ? { status: "success", outputs: body.outputs }
          : body.status === "business_outcome"
            ? { status: "business_outcome", outcome: body.outcome }
            : { status: "failure", error: body.error };
      console.error(`← ${JSON.stringify(summary)}`);
      results.push({
        type: "tool_result",
        tool_use_id: u.id,
        content: JSON.stringify(summary),
        is_error: body.status === "failure",
      });
    }
    messages.push({ role: "user", content: results });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

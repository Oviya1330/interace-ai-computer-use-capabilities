/**
 * Claude-backed decider. The model sees a screenshot with numbered marks plus the element
 * list and chooses tool calls; this class owns the (append-only) conversation, prompt
 * caching, refusal handling, usage accounting and a redacted transcript for evidence.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createRequire } from "node:module";
import type { EventSink } from "../core/events.js";
import { RunFailure, errorMessage } from "../core/errors.js";
import { AGENT_TOOLS } from "./tools.js";
import { SYSTEM_PROMPT, renderObservation, renderTask } from "./prompt.js";
import {
  ConditionProposal,
  ContractProposal,
  type ActionResult,
  type AgentAction,
  type ClassifyInput,
  type DecisionInput,
  type Decider,
  type FinalizeInput,
  type LlmUsage,
  type TaskSpec,
} from "./decider.js";

export interface LlmDeciderOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallbacks (default on; see Anthropic docs). */
  fallbacks?: boolean;
  contentFrame: string[];
  maxTokens?: number;
}

type Msg = Anthropic.Beta.BetaMessageParam;

export class LlmDecider implements Decider {
  readonly kind = "llm" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly messages: Msg[] = [];
  private readonly imageRefs = new Map<number, string>();
  private task!: TaskSpec;
  private events!: EventSink;
  private stats: LlmUsage;
  private nudges = 0;

  constructor(private readonly opts: LlmDeciderOptions) {
    this.model = opts.model ?? process.env.CUA_MODEL ?? "claude-opus-5";
    this.client = new Anthropic();
    this.stats = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: this.model,
    };
  }

  async start(task: TaskSpec, events: EventSink): Promise<void> {
    this.task = task;
    this.events = events;
  }

  private thinkingParam(): Record<string, unknown> {
    // Adaptive thinking on current models; Haiku 4.5 still uses the older budget form.
    if (/haiku-4-5/.test(this.model)) return {};
    return { thinking: { type: "adaptive", display: "summarized" } };
  }

  private image(obs: DecisionInput["observation"]): Anthropic.Beta.BetaImageBlockParam {
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: obs.screenshot.toString("base64") },
    };
  }

  async decide(input: DecisionInput): Promise<AgentAction[]> {
    const obsText = renderObservation(input.observation, this.opts.contentFrame);
    const note = input.note ? `\n\nNOTE FROM THE SYSTEM: ${input.note}` : "";
    const image = this.image(input.observation);
    if (this.messages.length === 0) {
      this.messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `${renderTask(this.task)}\n\nCURRENT SCREEN (turn ${input.stepNumber}):\n${obsText}${note}`,
          },
          image,
        ],
      });
    } else {
      const content: Anthropic.Beta.BetaToolResultBlockParam[] = input.results.map((r, i) => ({
        type: "tool_result",
        tool_use_id: r.id,
        is_error: r.isError ?? false,
        content:
          i === input.results.length - 1
            ? [
                {
                  type: "text",
                  text: `${r.text}\n\nCURRENT SCREEN (turn ${input.stepNumber}):\n${obsText}${note}`,
                },
                image,
              ]
            : [{ type: "text", text: r.text }],
      }));
      if (content.length === 0) {
        this.messages.push({
          role: "user",
          content: [
            { type: "text", text: `CURRENT SCREEN (turn ${input.stepNumber}):\n${obsText}${note}` },
            image,
          ],
        });
      } else {
        this.messages.push({ role: "user", content });
      }
    }
    if (input.screenshotRef) this.imageRefs.set(this.messages.length - 1, input.screenshotRef);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.call();
      this.messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "refusal") {
        throw new RunFailure(
          "LLM_ERROR",
          `The model declined to continue (${res.stop_details?.category ?? "unspecified"})`,
        );
      }
      const uses = res.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (uses.length === 0) {
        if (res.stop_reason === "max_tokens")
          throw new RunFailure("LLM_ERROR", "Model hit max_tokens without acting");
        if (++this.nudges > 2)
          throw new RunFailure("LLM_ERROR", "Model stopped issuing tool calls");
        this.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Continue with a tool call: act on the screen, or call done / request_human / give_up.",
            },
          ],
        });
        continue;
      }
      return uses.map(
        (u) => ({ id: u.id, tool: u.name, ...(u.input as Record<string, unknown>) }) as AgentAction,
      );
    }
    throw new RunFailure("LLM_ERROR", "Model did not produce an action");
  }

  private async call(): Promise<Anthropic.Beta.BetaMessage> {
    const useFallbacks = this.opts.fallbacks !== false;
    const extra: Record<string, unknown> = useFallbacks ? { fallbacks: "default" } : {};
    const started = Date.now();
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: this.opts.maxTokens ?? 8192,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: AGENT_TOOLS,
        tool_choice: { type: "auto" },
        messages: this.messages,
        output_config: { effort: this.opts.effort ?? (process.env.CUA_EFFORT as "high") ?? "high" },
        ...this.thinkingParam(),
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"] } : {}),
        ...extra,
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError)
        throw new RunFailure(
          "LLM_ERROR",
          "Anthropic authentication failed: set ANTHROPIC_API_KEY (see README)",
        );
      if (e instanceof Anthropic.RateLimitError)
        throw new RunFailure("LLM_ERROR", `Rate limited by the model API: ${e.message}`);
      if (e instanceof Anthropic.APIError)
        throw new RunFailure("LLM_ERROR", `Model API error ${e.status}: ${e.message}`);
      throw new RunFailure("LLM_ERROR", `Model call failed: ${errorMessage(e)}`);
    }
    this.stats.calls++;
    this.stats.inputTokens += res.usage.input_tokens;
    this.stats.outputTokens += res.usage.output_tokens;
    this.stats.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    this.stats.cacheWriteTokens += res.usage.cache_creation_input_tokens ?? 0;
    const thinking = res.content
      .filter((b): b is Anthropic.Beta.BetaThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking)
      .filter(Boolean)
      .join("\n");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const fellBack = res.content.some((b) => (b as { type: string }).type === "fallback");
    this.events.emit(
      "agent.llm",
      `LLM call ${this.stats.calls}: ${res.model} stop=${res.stop_reason} in=${res.usage.input_tokens} out=${res.usage.output_tokens} cache_read=${res.usage.cache_read_input_tokens ?? 0} (${Date.now() - started}ms)`,
      {
        model: res.model,
        requestedModel: this.model,
        fellBack,
        stopReason: res.stop_reason,
        usage: res.usage,
        ms: Date.now() - started,
        ...(thinking ? { thinking } : {}),
        ...(text ? { text } : {}),
      },
    );
    return res;
  }

  async finalize(input: FinalizeInput): Promise<ContractProposal> {
    const stepLines = input.steps
      .map((s, i) => `${i + 1}. [${s.kind}] ${s.name}${s.intent ? ` — ${s.intent}` : ""}`)
      .join("\n");
    const outputLines =
      input.outputs
        .map((o) => `- ${o.name}: sample ${JSON.stringify(o.sample)} (parsed as ${o.parse})`)
        .join("\n") || "(none)";
    const prompt = `A computer-use flow was just recorded against "${input.app}" and will be published as a reusable capability that AI agents invoke by name with typed inputs. Write its contract.

GOAL: ${input.goal}
INPUT PARAMETERS (name = example value): ${
      Object.entries(input.inputs)
        .map(([k, v]) => `${k} = "${v}"`)
        .join(", ") || "(none)"
    }
RECORDED STEPS:
${stepLines}
EXTRACTED OUTPUTS:
${outputLines}
${input.suggestedName ? `SUGGESTED NAME: ${input.suggestedName}` : ""}

Rules: name is dotted snake_case (domain.verb_object, e.g. member.lookup_savings_balance); descriptions must tell a reviewer what it does, needs and returns; classify sensitivity (member/account identifiers = pii, balances/amounts = financial); give a regex pattern only when the format is certain; sideEffects reflects what the flow changes in the system of record; checkpointDescription states what proves success.`;
    return this.structured(prompt, ContractProposal, "contract");
  }

  async classify(input: ClassifyInput): Promise<ConditionProposal> {
    const obsText = renderObservation(input.observation, this.opts.contentFrame);
    const prompt = `A deterministic replay of a recorded capability stopped in an unexpected state. Classify the state so future replays can detect and handle it without a model.

GOAL: ${input.goal}
INPUTS: ${Object.entries(input.inputs)
      .map(([k, v]) => `${k} = "${v}"`)
      .join(", ")}
REPLAY FAILURE: ${input.failure.code} — ${input.failure.message}${input.failure.stepName ? ` (at step "${input.failure.stepName}")` : ""}

CURRENT SCREEN:
${obsText}

Classes:
- business_outcome: the application answered legitimately (record not found, validation error, access denied). The caller must receive it as a result, not an error.
- recoverable: a transient/interstitial state (notice to acknowledge, slow load) that a fixed handler can clear; give dismissRef for the control to click.
- hard_failure: an application error or an unknown state that must stop the run.
detectorText must be a short exact substring of the visible text that identifies this state on any record (do not include record-specific values like the member number).`;
    const res = await this.structured(prompt, ConditionProposal, "condition", input.observation);
    return res;
  }

  private async structured<T extends typeof ContractProposal | typeof ConditionProposal>(
    prompt: string,
    schema: T,
    what: string,
    obs?: DecisionInput["observation"],
  ): Promise<T["_output"]> {
    const content: Anthropic.ContentBlockParam[] = obs
      ? [{ type: "text", text: prompt }, this.image(obs) as Anthropic.ImageBlockParam]
      : [{ type: "text", text: prompt }];
    const started = Date.now();
    try {
      const res = await this.client.messages.parse({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: "user", content }],
        output_config: { format: zodOutputFormat(schema) },
      });
      this.account(res.usage, res.model, res.stop_reason, started, what);
      if (res.stop_reason === "refusal")
        throw new RunFailure("LLM_ERROR", `Model declined to produce the ${what}`);
      if (!res.parsed_output)
        throw new RunFailure("LLM_ERROR", `Model returned no parsable ${what}`);
      return schema.parse(res.parsed_output) as T["_output"];
    } catch (e) {
      if (e instanceof RunFailure) throw e;
      if (e instanceof Anthropic.APIError && e.status !== 400)
        throw new RunFailure("LLM_ERROR", `Model API error ${e.status}: ${e.message}`);
      // Fallback: plain JSON instruction (in case structured outputs are unavailable).
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              ...content,
              {
                type: "text",
                text:
                  "Respond with ONLY a JSON object matching this JSON Schema:\n" +
                  JSON.stringify(z.toJSONSchema(schema)),
              },
            ],
          },
        ],
      });
      this.account(res.usage, res.model, res.stop_reason, started, what);
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m)
        throw new RunFailure("LLM_ERROR", `Model returned no JSON ${what}: ${errorMessage(e)}`);
      return schema.parse(JSON.parse(m[0])) as T["_output"];
    }
  }

  private account(
    usage: Anthropic.Usage,
    model: string,
    stop: string | null,
    started: number,
    what: string,
  ): void {
    this.stats.calls++;
    this.stats.inputTokens += usage.input_tokens;
    this.stats.outputTokens += usage.output_tokens;
    this.stats.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.stats.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.events.emit(
      "agent.llm",
      `LLM ${what} call: ${model} stop=${stop} in=${usage.input_tokens} out=${usage.output_tokens} (${Date.now() - started}ms)`,
      {
        model,
        what,
        stopReason: stop,
        usage,
        ms: Date.now() - started,
      },
    );
  }

  transcript(): unknown {
    return {
      decider: "llm",
      model: this.model,
      system: SYSTEM_PROMPT,
      tools: AGENT_TOOLS.map((t) => t.name),
      messages: this.messages.map((m, idx) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) => {
                if (b.type === "image")
                  return { type: "image", ref: this.imageRefs.get(idx) ?? "(screenshot)" };
                if (b.type === "tool_result") {
                  return {
                    ...b,
                    content:
                      typeof b.content === "string"
                        ? b.content
                        : b.content?.map((c) =>
                            c.type === "image"
                              ? { type: "image", ref: this.imageRefs.get(idx) ?? "(screenshot)" }
                              : c,
                          ),
                  };
                }
                if (b.type === "thinking")
                  return {
                    type: "thinking",
                    thinking: (b as Anthropic.Beta.BetaThinkingBlock).thinking,
                  };
                return b;
              }),
      })),
      usage: this.stats,
    };
  }

  usage(): LlmUsage {
    return { ...this.stats };
  }
}

export function toolVersions(): Record<string, string> {
  const req = createRequire(import.meta.url);
  const v = (pkg: string): string => {
    try {
      return (req(`${pkg}/package.json`) as { version: string }).version;
    } catch {
      return "unknown";
    }
  };
  return {
    "@anthropic-ai/sdk": v("@anthropic-ai/sdk"),
    playwright: v("playwright"),
    node: process.version,
  };
}

export type { ActionResult };

/**
 * Deterministic decider for tests and for running the discovery pipeline without model
 * access. It exercises the exact same loop, recorder, policy gate and evidence path as the
 * LLM decider; only the choice of action is scripted.
 */
import type { Observation, ElementInfo } from "../surface/types.js";
import type {
  ActionResult,
  AgentAction,
  AssistInput,
  AssistProposal,
  ClassifyInput,
  ConditionProposal,
  ContractProposal,
  DecisionInput,
  Decider,
  FinalizeInput,
  LlmUsage,
  TaskSpec,
} from "./decider.js";
import type { EventSink } from "../core/events.js";

export type Finder = (obs: Observation) => ElementInfo | undefined;
export type ScriptStep = (
  obs: Observation,
  results: ActionResult[],
) => Array<Omit<AgentAction, "id">> | "skip";

export const find = {
  byRoleName:
    (role: string, name: string | RegExp, frame?: string): Finder =>
    (obs) =>
      obs.elements.find(
        (e) =>
          e.role === role &&
          (typeof name === "string"
            ? e.name === name || e.text === name || e.labelText === name
            : name.test(e.name || e.text || e.labelText || "")) &&
          (!frame || e.frame.join("/") === frame),
      ),
  byLabel:
    (label: string): Finder =>
    (obs) =>
      obs.elements.find((e) => e.interactive && (e.labelText === label || e.name === label)),
  cell:
    (column: string, rowContains: string): Finder =>
    (obs) =>
      obs.elements.find(
        (e) =>
          !!e.table &&
          !e.table.isHeader &&
          e.table.columnHeader === column &&
          e.table.rowCells.some((c) => c === rowContains),
      ),
  text:
    (text: string): Finder =>
    (obs) =>
      obs.elements.find((e) => e.text === text || e.name === text),
};

export class ScriptedDecider implements Decider {
  readonly kind = "scripted" as const;
  readonly model = "scripted";
  private i = 0;
  private log: unknown[] = [];
  private task: TaskSpec | null = null;

  constructor(
    private readonly script: ScriptStep[],
    private readonly contract: (input: FinalizeInput) => ContractProposal,
    private readonly classifier: (input: ClassifyInput) => ConditionProposal = () => ({
      class: "hard_failure",
      code: "UNKNOWN_STATE",
      description: "Unclassified state",
      message: "Unclassified state",
      detectorText: "Application",
      dismissRef: null,
    }),
  ) {}

  async start(task: TaskSpec, _events: EventSink): Promise<void> {
    this.task = task;
    this.log.push({ role: "task", task });
  }

  async decide(input: DecisionInput): Promise<AgentAction[]> {
    this.log.push({
      role: "observation",
      url: input.observation.url,
      landmark: input.observation.landmark,
      results: input.results,
    });
    while (this.i < this.script.length) {
      const step = this.script[this.i++]!;
      const actions = step(input.observation, input.results);
      if (actions === "skip") continue;
      const withIds = actions.map(
        (a, k) => ({ ...a, id: `scripted_${this.i}_${k}` }) as AgentAction,
      );
      this.log.push({ role: "actions", actions: withIds });
      return withIds;
    }
    const a: AgentAction = {
      id: "scripted_end",
      tool: "give_up",
      reason: "script exhausted",
      kind: "impossible",
    };
    this.log.push({ role: "actions", actions: [a] });
    return [a];
  }

  async finalize(input: FinalizeInput): Promise<ContractProposal> {
    return this.contract(input);
  }

  async classify(input: ClassifyInput): Promise<ConditionProposal> {
    return this.classifier(input);
  }

  /**
   * Heuristic stand-in for the model: score visible elements by overlap with the words of
   * the step's target description / intent, preferring the same role. Good enough to let
   * tests exercise the assisted-recovery path deterministically.
   */
  async assist(input: AssistInput): Promise<AssistProposal> {
    const words =
      `${input.step.targetDescription ?? ""} ${input.step.intent ?? ""} ${input.step.name}`
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter(
          (w) =>
            w.length > 2 &&
            ![
              "the",
              "frame",
              "main",
              "nav",
              "into",
              "click",
              "enter",
              "link",
              "button",
              "textbox",
              "combobox",
            ].includes(w),
        );
    const roleMatch = /the (\w+) "/.exec(input.step.targetDescription ?? "")?.[1];
    let best: { ref: string; score: number; label: string } | null = null;
    for (const e of input.observation.elements) {
      if (!e.interactive) continue;
      const hay = `${e.name} ${e.labelText ?? ""} ${e.text} ${e.attrs.name ?? ""}`.toLowerCase();
      let score = words.filter((w) => hay.includes(w)).length;
      if (roleMatch && e.role === roleMatch) score += 0.5;
      if (input.step.kind === "type" && e.role !== "textbox") score -= 2;
      if (input.step.kind === "click" && !["link", "button"].includes(e.role)) score -= 2;
      if (score > (best?.score ?? 0))
        best = { ref: e.ref, score, label: e.name || e.labelText || e.text };
    }
    if (!best || best.score < 1) {
      // No wording overlap (e.g. "Search" relabelled "Find"): accept the control only when it is
      // the single interactive element of the expected role in the recorded frame.
      const wantRole =
        roleMatch ??
        (input.step.kind === "type"
          ? "textbox"
          : input.step.kind === "select"
            ? "combobox"
            : undefined);
      const frame = /in frame (\S+)$/.exec(input.step.targetDescription ?? "")?.[1];
      const candidates = input.observation.elements.filter(
        (e) =>
          e.interactive &&
          (!wantRole || e.role === wantRole) &&
          (!frame || e.frame.join("/") === frame),
      );
      if (wantRole && candidates.length === 1) {
        const only = candidates[0]!;
        best = {
          ref: only.ref,
          score: 1,
          label: `${only.name || only.labelText || only.text} (the only ${wantRole} on the screen)`,
        };
      }
    }
    this.log.push({ role: "assist", step: input.step.id, proposal: best });
    return best && best.score >= 1
      ? {
          ref: best.ref,
          reason: `"${best.label}" best matches the step's intent (score ${best.score})`,
        }
      : { ref: null, reason: "no visible element matches the step's intent" };
  }

  transcript(): unknown {
    return { decider: "scripted", task: this.task, log: this.log };
  }

  usage(): LlmUsage {
    return {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "scripted",
    };
  }
}

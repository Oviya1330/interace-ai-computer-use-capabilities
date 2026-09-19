/**
 * Deterministic decider for tests and for running the discovery pipeline without model
 * access. It exercises the exact same loop, recorder, policy gate and evidence path as the
 * LLM decider; only the choice of action is scripted.
 */
import type { Observation, ElementInfo } from "../surface/types.js";
import type {
  ActionResult,
  AgentAction,
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

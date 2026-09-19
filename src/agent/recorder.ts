/**
 * Turns accepted actions + observations into artifact steps. This is where the transcript
 * stops mattering: everything replay needs is derived here, parameterised, and typed.
 */
import type { Capability, Expectation, Step, Target, ValueRef, RiskClass } from "../core/schema.js";
import { SCHEMA_VERSION } from "../core/schema.js";
import type { Observation, ElementInfo, DialogRecord, Surface } from "../surface/types.js";
import { escapeRegex, parameterize, type Params } from "../core/template.js";
import type { AgentAction, ContractProposal } from "./decider.js";
import { ulid } from "../core/ids.js";

export interface RecordedOutput {
  name: string;
  parse: "text" | "number" | "currency";
  sample: unknown;
}

interface Draft {
  step: Step;
  before: Observation;
}

const PH = String.fromCharCode(1);

/**
 * "http://host/t/summit/member/10023" -> "^{{base_url}}/member/{{member_id}}(\?.*)?$"
 * Literal text is regex-escaped; placeholders are interpolated (and escaped) at replay time.
 */
export function canonicalUrlPattern(url: string, params: Params, baseUrl: string): string {
  const noHash = url.split("#")[0]!;
  let s = noHash.split("?")[0]!;
  if (s.startsWith(baseUrl)) s = `${PH}base_url${PH}${s.slice(baseUrl.length)}`;
  const entries = Object.entries(params)
    .filter(([k, v]) => k !== "base_url" && v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    s = s.split(`/${value}/`).join(`/${PH}${name}${PH}/`);
    if (s.endsWith(`/${value}`)) s = s.slice(0, -value.length) + `${PH}${name}${PH}`;
  }
  const pieces = s.split(new RegExp(`${PH}([a-zA-Z_][a-zA-Z0-9_]*)${PH}`));
  const out = pieces
    .map((piece, i) =>
      i % 2 ? `{{${piece}}}` : escapeRegex(piece).replace(/\/\d+(?=\/|$)/g, "/\\d+"),
    )
    .join("");
  return `^${out}(\\?.*)?$`;
}

export class Recorder {
  readonly steps: Step[] = [];
  readonly outputs: RecordedOutput[] = [];
  private pending: Draft | null = null;
  private counter = 0;
  private evidenceTarget: { target: Target; text: string; frame: string[] } | null = null;

  constructor(
    private readonly surface: Surface,
    private readonly params: Params,
    private readonly baseUrl: string,
    private readonly contentFrame: string[],
  ) {}

  private nextId(kind: string, hint?: string): string {
    this.counter++;
    const slug = (hint ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    return `s${String(this.counter).padStart(2, "0")}-${kind}${slug ? `-${slug}` : ""}`;
  }

  private valueRef(text: string): ValueRef {
    for (const [name, value] of Object.entries(this.params)) {
      if (name === "base_url") continue;
      if (text === value) return { kind: "param", name };
    }
    const templ = parameterize(text, this.params);
    if (templ !== text) return { kind: "template", template: templ };
    return { kind: "literal", value: text };
  }

  /** Called when the next observation is available: the previous draft gets its post-conditions. */
  completePending(after: Observation): void {
    if (!this.pending) return;
    const { step, before } = this.pending;
    this.pending = null;
    if (step.kind === "type" && !step.pressEnter) {
      this.steps.push(step);
      return;
    }
    step.expect = [...step.expect, ...this.deriveExpectations(before, after)];
    this.steps.push(step);
  }

  private deriveExpectations(before: Observation, after: Observation): Expectation[] {
    const out: Expectation[] = [];
    const contentKey = this.contentFrame.join("/");
    const beforeUrls = new Map(before.frames.map((f) => [f.path.join("/"), f.url]));
    for (const f of after.frames) {
      const key = f.path.join("/");
      if (key !== contentKey) continue;
      if (beforeUrls.get(key) !== f.url && /^https?:/.test(f.url)) {
        out.push({
          kind: "url",
          pattern: canonicalUrlPattern(f.url, this.params, this.baseUrl),
          frame: f.path,
        });
      }
    }
    if (after.landmark && after.landmark !== before.landmark) {
      const text = parameterize(after.landmark, this.params);
      if (!/\d/.test(text) || text.includes("{{"))
        out.push({ kind: "text", text, frame: this.contentFrame });
    }
    return out;
  }

  recordAction(
    action: AgentAction,
    el: ElementInfo | null,
    before: Observation,
    risk: RiskClass,
    dialogs: DialogRecord[],
    extra?: { raw?: string; value?: unknown },
  ): Step | null {
    // Batched actions share one observation: the previous draft cannot get derived
    // post-conditions, but it must never be lost.
    if (this.pending) this.flush(null);
    const target = el ? this.surface.describeTarget(el, this.params, before.screenshotPlain) : null;
    const base = (kind: string, name: string, hint?: string) => ({
      id: this.nextId(kind, hint),
      name,
      intent: "why" in action ? parameterize(action.why, this.params) : undefined,
      risk,
      expect: [] as Expectation[],
    });
    const label = el
      ? parameterize(el.name || el.labelText || el.text || el.attrs.name || el.role, this.params)
      : "";
    let step: Step | null = null;
    switch (action.tool) {
      case "click": {
        step = {
          kind: "click",
          target: target!,
          ...base("click", `Click ${target!.description}`, label),
        };
        const accepted = dialogs.find((d) => d.expected && d.response === "accept");
        if (accepted) {
          const pattern = escapeRegex(parameterize(accepted.message, this.params))
            .replace(/\\\{\\\{/g, "{{")
            .replace(/\\\}\\\}/g, "}}");
          step.dialog = { messagePattern: pattern, response: "accept" };
        }
        break;
      }
      case "type": {
        const value = this.valueRef(action.text);
        step = {
          kind: "type",
          target: target!,
          value,
          clear: true,
          ...(action.press_enter ? { pressEnter: true } : {}),
          ...base(
            "type",
            `Enter ${describeValueForName(value)} into ${target!.description}`,
            label,
          ),
        };
        break;
      }
      case "type_secret":
        step = {
          kind: "type",
          target: target!,
          value: { kind: "secret", ref: action.secret },
          clear: true,
          ...base("type", `Enter secret ${action.secret} into ${target!.description}`, label),
        };
        break;
      case "select": {
        const value = this.valueRef(action.value);
        step = {
          kind: "select",
          target: target!,
          value,
          ...base(
            "select",
            `Select ${describeValueForName(value)} in ${target!.description}`,
            label,
          ),
        };
        break;
      }
      case "press":
        step = { kind: "press", key: action.key, ...base("press", `Press ${action.key}`) };
        break;
      case "navigate": {
        const templ = action.url.startsWith(this.baseUrl)
          ? `{{base_url}}${action.url.slice(this.baseUrl.length)}`
          : action.url;
        const value: ValueRef = templ.includes("{{")
          ? { kind: "template", template: parameterize(templ, this.params) }
          : { kind: "literal", value: action.url };
        step = { kind: "navigate", url: value, ...base("navigate", `Open ${templ}`) };
        break;
      }
      case "extract": {
        const parse = action.parse ?? inferParse(extra?.raw ?? "");
        step = {
          kind: "extract",
          target: target!,
          output: action.output,
          parse: { type: parse },
          ...base("extract", `Read ${action.output} from ${target!.description}`, action.output),
        };
        this.outputs.push({ name: action.output, parse, sample: extra?.value });
        break;
      }
      case "done": {
        if (target && el)
          this.evidenceTarget = {
            target,
            text: parameterize(el.text || el.name, this.params),
            frame: el.frame,
          };
        return null;
      }
      default:
        return null;
    }
    this.pending = { step, before };
    return step;
  }

  /** Flush a pending draft when the run ends. */
  flush(after: Observation | null): void {
    if (after) this.completePending(after);
    else if (this.pending) {
      this.steps.push(this.pending.step);
      this.pending = null;
    }
  }

  buildCheckpoint(finalObs: Observation): { description: string; expect: Expectation[] } {
    const expect: Expectation[] = [];
    const contentKey = this.contentFrame.join("/");
    const content = finalObs.frames.find((f) => f.path.join("/") === contentKey);
    if (content && /^https?:/.test(content.url)) {
      expect.push({
        kind: "url",
        pattern: canonicalUrlPattern(content.url, this.params, this.baseUrl),
        frame: content.path,
      });
    }
    if (this.evidenceTarget && this.evidenceTarget.text) {
      expect.push({
        kind: "text",
        text: this.evidenceTarget.text,
        frame: this.evidenceTarget.frame,
      });
    } else if (finalObs.landmark) {
      expect.push({
        kind: "text",
        text: parameterize(finalObs.landmark, this.params),
        frame: this.contentFrame,
      });
    }
    const description = this.evidenceTarget
      ? `The screen shows "${this.evidenceTarget.text}"${content ? ` at ${canonicalUrlPattern(content.url, this.params, this.baseUrl)}` : ""}`
      : `The content frame reached ${content?.url ?? "the final screen"}`;
    return { description, expect };
  }

  assemble(a: {
    contract: ContractProposal;
    version: string;
    goal: string;
    profileId: string;
    surface: "web" | "legacy_web" | "desktop";
    family: string;
    tenant: string;
    runId: string;
    decider: { kind: "llm" | "scripted"; model: string };
    checkpoint: { description: string; expect: Expectation[] };
    allowedOrigins: string[];
    inputSensitivity: Record<string, "none" | "pii" | "financial" | "secret">;
    tenantParamNames: string[];
    toolVersions: Record<string, string>;
  }): Capability {
    const maxRisk = this.steps.reduce<RiskClass>(
      (acc, s) => (rank(s.risk) > rank(acc) ? s.risk : acc),
      "safe",
    );
    const inputs: Capability["inputs"] = {};
    for (const [name, value] of Object.entries(this.params)) {
      if (a.tenantParamNames.includes(name)) continue;
      const spec = a.contract.inputs.find((i) => i.name === name);
      const sensitivity = a.inputSensitivity[name] ?? spec?.sensitivity ?? "none";
      inputs[name] = {
        type: spec?.type ?? "string",
        description: spec?.description ?? `Value for ${name}`,
        required: true,
        // Real values never enter the artifact when the input is sensitive.
        ...(sensitivity === "none" ? { example: value } : {}),
        sensitivity,
        ...(spec?.pattern ? { pattern: spec.pattern } : {}),
      };
    }
    const outputs: Capability["outputs"] = {};
    for (const o of this.outputs) {
      const spec = a.contract.outputs.find((x) => x.name === o.name);
      outputs[o.name] = {
        type: spec?.type ?? (o.parse === "text" ? "string" : "number"),
        description: spec?.description ?? `Extracted ${o.name}`,
        sensitivity: spec?.sensitivity ?? (o.parse === "currency" ? "financial" : "none"),
      };
    }
    const cap: Capability = {
      schemaVersion: SCHEMA_VERSION,
      id: ulid(),
      name: a.contract.name,
      version: a.version,
      status: "draft",
      title: parameterize(a.contract.title, this.params),
      description: parameterize(a.contract.description, this.params),
      goal: parameterize(a.goal, this.params),
      app: { profile: a.profileId, surface: a.surface, family: a.family },
      entry: { url: { kind: "template", template: "{{base_url}}/" }, requiresSession: true },
      inputs,
      outputs,
      policy: {
        riskClass: maxRisk,
        sideEffects: a.contract.sideEffects,
        requiresApproval: maxRisk !== "safe",
        allowedOrigins: a.allowedOrigins,
      },
      steps: this.steps,
      checkpoint: {
        description: a.contract.checkpointDescription || a.checkpoint.description,
        expect: a.checkpoint.expect,
      },
      conditions: [],
      overrides: {},
      provenance: {
        recordedAt: new Date().toISOString(),
        recordedBy: { kind: a.decider.kind, model: a.decider.model },
        discoveryRunId: a.runId,
        tenant: a.tenant,
        tools: a.toolVersions,
        transcriptRef: "transcript.json",
      },
      stats: { replays: 0, successes: 0, businessOutcomes: 0, failures: 0 },
    };
    return sanitize(cap, this.params, a.tenantParamNames);
  }
}

/**
 * Final guarantee: no run-specific input value survives in any free-text field of the
 * artifact (goal, intents, descriptions, names). Values are replaced by their placeholder.
 * Visual templates (PNG data) are left untouched.
 */
function sanitize(cap: Capability, params: Params, tenantParamNames: string[]): Capability {
  const inputs: Params = {};
  for (const [k, v] of Object.entries(params)) if (!tenantParamNames.includes(k)) inputs[k] = v;
  return JSON.parse(
    JSON.stringify(cap, (key, value) =>
      typeof value === "string" && key !== "template" ? parameterize(value, inputs) : value,
    ),
  ) as Capability;
}

function rank(r: RiskClass): number {
  return r === "safe" ? 0 : r === "mutating" ? 1 : 2;
}

function describeValueForName(v: ValueRef): string {
  return v.kind === "param"
    ? `{{${v.name}}}`
    : v.kind === "template"
      ? v.template
      : v.kind === "literal"
        ? `"${v.value}"`
        : "<secret>";
}

export function inferParse(raw: string): "text" | "number" | "currency" {
  const t = raw.trim();
  if (/^\(?-?\$\s?[\d,]+(\.\d{1,2})?\)?$/.test(t)) return "currency";
  if (/^-?[\d,]+(\.\d+)?$/.test(t)) return "number";
  return "text";
}

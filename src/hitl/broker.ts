/**
 * Human-in-the-loop broker: the control-transfer model.
 *
 * Exactly one party holds control of a live session at any time:
 *   automation  — the engine issues actions; the operator console is view-only.
 *   human       — the engine is blocked awaiting a resolution; operator input is forwarded to
 *                 the SAME browser session over CDP; every human action is recorded.
 *
 * The engine never continues on its own after raising an intervention: it awaits a
 * resolution (resume / retry / skip / abort / approve / deny) or a timeout.
 */
import { EventEmitter } from "node:events";
import type { EventSink } from "../core/events.js";
import type { Target } from "../core/schema.js";
import type { ElementInfo } from "../surface/types.js";
import { shortId } from "../core/ids.js";

export type InterventionType = "stuck" | "approval" | "failure" | "agent_request";
export type ResolutionKind = "resume" | "retry" | "skip" | "abort" | "approve" | "deny";
export type ControlOwner = "automation" | "human";

export interface HumanAction {
  at: string;
  kind: "click" | "key" | "text";
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  /** What was under the pointer, described as a replayable target. */
  target?: Target;
  element?: { role: string; name: string; text: string; frame: string[] };
  screenshot?: string;
}

export interface InterventionResolution {
  kind: ResolutionKind;
  note?: string;
  operator?: string;
  at: string;
}

export interface InterventionRequest {
  id: string;
  runId: string;
  runKind: "discovery" | "replay";
  type: InterventionType;
  raisedAt: string;
  capability: { name: string; version: string } | null;
  goal?: string;
  tenant: string;
  step?: { id: string; index: number; name: string; kind: string };
  reason: { code: string; message: string; expected?: string; observed?: string };
  url: string;
  landmark?: string;
  /** Evidence-relative screenshot path. */
  screenshot?: string;
  /** Interactive elements at the time of the request (for the console's hover hints). */
  elements: Array<Pick<ElementInfo, "ref" | "role" | "name" | "text" | "bbox" | "frame">>;
  allowedResolutions: ResolutionKind[];
  status: "open" | "in_control" | "resolved" | "expired";
  control: { owner: ControlOwner; since: string; operator?: string };
  controlTransfers: number;
  humanActions: HumanAction[];
  resolution?: InterventionResolution;
  timeoutMs: number;
}

interface Pending {
  req: InterventionRequest;
  resolve: (r: InterventionResolution) => void;
  timer: NodeJS.Timeout;
  events: EventSink;
  screenshotPng?: Buffer;
}

export class InterventionTimeout extends Error {
  constructor(public readonly intervention: InterventionRequest) {
    super(`No operator responded within ${intervention.timeoutMs}ms`);
    this.name = "InterventionTimeout";
  }
}

export interface RaiseInput extends Omit<
  InterventionRequest,
  "id" | "raisedAt" | "status" | "control" | "controlTransfers" | "humanActions" | "resolution"
> {
  screenshotPng?: Buffer;
}

export class InterventionBroker extends EventEmitter {
  private pending = new Map<string, Pending>();
  private history: InterventionRequest[] = [];

  /** Raise an intervention and block until a human resolves it (or it times out). */
  raise(input: RaiseInput, events: EventSink): Promise<InterventionResolution> {
    const { screenshotPng, ...rest } = input;
    const req: InterventionRequest = {
      ...rest,
      id: shortId("int"),
      raisedAt: new Date().toISOString(),
      status: "open",
      control: { owner: "automation", since: new Date().toISOString() },
      controlTransfers: 0,
      humanActions: [],
    };
    events.emit(
      "intervention.raised",
      `Intervention ${req.id} (${req.type}): ${req.reason.message}`,
      {
        id: req.id,
        type: req.type,
        reason: req.reason,
        step: req.step,
        url: req.url,
        screenshot: req.screenshot,
        allowedResolutions: req.allowedResolutions,
      },
    );
    return new Promise<InterventionResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(req.id)) return;
        req.status = "expired";
        this.pending.delete(req.id);
        this.history.push(req);
        events.emit("intervention.resolved", `Intervention ${req.id} expired`, {
          id: req.id,
          expired: true,
        });
        this.emit("update");
        reject(new InterventionTimeout(req));
      }, req.timeoutMs);
      this.pending.set(req.id, { req, resolve, timer, events, screenshotPng });
      this.emit("raised", req);
      this.emit("update");
    });
  }

  list(): InterventionRequest[] {
    return [...[...this.pending.values()].map((p) => p.req), ...this.history];
  }

  get(id: string): InterventionRequest | undefined {
    return this.pending.get(id)?.req ?? this.history.find((h) => h.id === id);
  }

  screenshotOf(id: string): Buffer | undefined {
    return this.pending.get(id)?.screenshotPng;
  }

  /** Who may drive the live session right now. */
  controlOwner(): ControlOwner {
    for (const p of this.pending.values()) if (p.req.control.owner === "human") return "human";
    return "automation";
  }

  activeControlled(): InterventionRequest | undefined {
    for (const p of this.pending.values()) if (p.req.control.owner === "human") return p.req;
    return undefined;
  }

  takeControl(id: string, operator: string): InterventionRequest {
    const p = this.mustPending(id);
    if (p.req.control.owner === "human") throw new Error("A human already holds control");
    p.req.control = { owner: "human", since: new Date().toISOString(), operator };
    p.req.status = "in_control";
    p.req.controlTransfers++;
    p.events.emit("control.transfer", `Control → human (${operator}) for ${id}`, {
      id,
      owner: "human",
      operator,
    });
    this.emit("control", p.req);
    this.emit("update");
    return p.req;
  }

  recordHumanAction(id: string, action: HumanAction): void {
    const p = this.mustPending(id);
    if (p.req.control.owner !== "human") throw new Error("Human does not hold control");
    p.req.humanActions.push(action);
    p.events.emit(
      "human.action",
      `Human ${action.kind}${action.element ? ` on ${action.element.role} "${action.element.name || action.element.text}"` : ""}`,
      {
        id,
        ...action,
      },
    );
    this.emit("update");
  }

  /** Hand control back with a resolution (or resolve an approval without taking control). */
  resolve(id: string, resolution: Omit<InterventionResolution, "at">): InterventionRequest {
    const p = this.mustPending(id);
    if (!p.req.allowedResolutions.includes(resolution.kind)) {
      throw new Error(
        `Resolution "${resolution.kind}" not allowed; allowed: ${p.req.allowedResolutions.join(", ")}`,
      );
    }
    if (p.req.control.owner === "human") {
      p.req.control = { owner: "automation", since: new Date().toISOString() };
      p.events.emit("control.transfer", `Control → automation for ${id}`, {
        id,
        owner: "automation",
      });
    }
    const full: InterventionResolution = { ...resolution, at: new Date().toISOString() };
    p.req.resolution = full;
    p.req.status = "resolved";
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.history.push(p.req);
    p.events.emit(
      "intervention.resolved",
      `Intervention ${id} resolved: ${full.kind}${full.note ? ` (${full.note})` : ""}`,
      {
        id,
        resolution: full,
        humanActions: p.req.humanActions.length,
        controlTransfers: p.req.controlTransfers,
      },
    );
    this.emit("control", p.req);
    this.emit("resolved", p.req);
    this.emit("update");
    p.resolve(full);
    return p.req;
  }

  private mustPending(id: string): Pending {
    const p = this.pending.get(id);
    if (!p) throw new Error(`Intervention ${id} is not open`);
    return p;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}

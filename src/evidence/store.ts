/**
 * Evidence for one run: a redacted JSONL event log, screenshots per step, richer signals on
 * failure (DOM snapshot + Playwright trace), and the final result / artifact copies.
 */
import fs from "node:fs";
import path from "node:path";
import type { EventSink, EventType, RunEvent } from "../core/events.js";
import type { Redactor } from "../policy/redact.js";

export class RunEvidence implements EventSink {
  readonly dir: string;
  readonly eventsPath: string;
  private seq = 0;
  private listeners: Array<(e: RunEvent) => void> = [];

  constructor(
    root: string,
    public readonly runId: string,
    private readonly redactor: Redactor,
    label?: string,
  ) {
    this.dir = path.join(root, label ? `${label}` : runId);
    fs.mkdirSync(path.join(this.dir, "steps"), { recursive: true });
    this.eventsPath = path.join(this.dir, "events.jsonl");
    fs.writeFileSync(this.eventsPath, "");
  }

  onEvent(fn: (e: RunEvent) => void): void {
    this.listeners.push(fn);
  }

  emit(type: EventType, msg: string, data?: Record<string, unknown>): void {
    const ev: RunEvent = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      runId: this.runId,
      type,
      msg: this.redactor.redactString(msg),
      ...(data ? { data: this.redactor.redact(data) } : {}),
    };
    fs.appendFileSync(this.eventsPath, JSON.stringify(ev) + "\n");
    for (const l of this.listeners) l(ev);
  }

  rel(p: string): string {
    return path.relative(this.dir, p);
  }

  saveScreenshot(name: string, png: Buffer, sub = "steps"): string {
    const file = path.join(this.dir, sub, `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return this.rel(file);
  }

  saveJson(name: string, value: unknown, opts: { redact?: boolean } = {}): string {
    const file = path.join(this.dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = opts.redact === false ? value : this.redactor.redact(value);
    const text = JSON.stringify(payload, null, 2);
    this.redactor.assertClean(text, name);
    fs.writeFileSync(file, text + "\n");
    return this.rel(file);
  }

  saveText(name: string, text: string): string {
    const file = path.join(this.dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const redacted = this.redactor.redactString(text);
    fs.writeFileSync(file, redacted);
    return this.rel(file);
  }

  filePath(name: string): string {
    return path.join(this.dir, name);
  }
}

export function readEvents(eventsPath: string): RunEvent[] {
  return fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);
}

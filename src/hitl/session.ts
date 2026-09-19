/**
 * Live-session control for a human operator, on the SAME browser session the automation uses.
 * Frames are streamed with CDP Page.startScreencast; operator input is forwarded with
 * CDP Input.dispatch*. Input is accepted only while the broker says a human holds control,
 * and every click/keystroke is recorded as evidence (with a replayable target descriptor).
 */
import type { CDPSession } from "playwright";
import type { PlaywrightSurface } from "../surface/playwright.js";
import type { InterventionBroker, HumanAction } from "./broker.js";
import type { RunEvidence } from "../evidence/store.js";
import type { Params } from "../core/template.js";
import { sleep } from "../core/util.js";

export interface ScreencastFrame {
  data: string; // base64 jpeg
  width: number;
  height: number;
}

const VK: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

export class LiveSessionController {
  private cdp: CDPSession | null = null;
  private listeners = new Set<(f: ScreencastFrame) => void>();
  private actionCount = 0;
  private lastFrame: ScreencastFrame | null = null;

  constructor(
    private readonly surface: PlaywrightSurface,
    private readonly broker: InterventionBroker,
    private evidence: RunEvidence | null,
    private params: Params,
  ) {}

  /** Parameters used to parameterise recorded human actions (tenant params + run inputs). */
  setParams(params: Params): void {
    this.params = params;
  }

  setEvidence(evidence: RunEvidence | null): void {
    this.evidence = evidence;
  }

  get streaming(): boolean {
    return this.cdp !== null;
  }

  latestFrame(): ScreencastFrame | null {
    return this.lastFrame;
  }

  onFrame(l: (f: ScreencastFrame) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async startScreencast(): Promise<void> {
    if (this.cdp) return;
    const cdp = await this.surface.cdp();
    this.cdp = cdp;
    const { width, height } = this.surface.opts.viewport;
    cdp.on(
      "Page.screencastFrame",
      (ev: {
        data: string;
        sessionId: number;
        metadata: { deviceWidth: number; deviceHeight: number };
      }) => {
        const frame = {
          data: ev.data,
          width: ev.metadata.deviceWidth,
          height: ev.metadata.deviceHeight,
        };
        this.lastFrame = frame;
        for (const l of this.listeners) l(frame);
        cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
      },
    );
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 55,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    this.cdp = null;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }

  private guard(): string {
    const active = this.broker.activeControlled();
    if (!active) throw new Error("Input rejected: automation holds control of the session");
    if (!this.cdp) throw new Error("Input rejected: screencast not active");
    return active.id;
  }

  async mouse(ev: {
    type: "mousePressed" | "mouseReleased" | "mouseMoved";
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | "none";
    clickCount?: number;
  }): Promise<void> {
    const id = this.guard();
    let action: HumanAction | null = null;
    if (ev.type === "mousePressed") {
      const el = await this.surface.describeAt(ev.x, ev.y).catch(() => null);
      action = {
        at: new Date().toISOString(),
        kind: "click",
        x: Math.round(ev.x),
        y: Math.round(ev.y),
      };
      if (el) {
        action.element = { role: el.role, name: el.name, text: el.text, frame: el.frame };
        try {
          const shot = await this.surface.screenshot();
          action.target = this.surface.describeTarget(el, this.params, shot);
        } catch {
          /* descriptor is best-effort */
        }
      }
    }
    await this.cdp!.send("Input.dispatchMouseEvent", {
      type: ev.type,
      x: ev.x,
      y: ev.y,
      button: ev.button ?? (ev.type === "mouseMoved" ? "none" : "left"),
      clickCount: ev.clickCount ?? (ev.type === "mouseMoved" ? 0 : 1),
    });
    if (action) {
      if (this.evidence) {
        await sleep(400);
        try {
          action.screenshot = this.evidence.saveScreenshot(
            `human-${++this.actionCount}`,
            await this.surface.screenshot(),
            `interventions/${id}`,
          );
        } catch {
          /* page may be navigating */
        }
      }
      this.broker.recordHumanAction(id, action);
    }
  }

  async key(ev: {
    type: "keyDown" | "keyUp";
    key: string;
    code?: string;
    text?: string;
  }): Promise<void> {
    const id = this.guard();
    const vk = VK[ev.key];
    await this.cdp!.send("Input.dispatchKeyEvent", {
      type: ev.type,
      key: ev.key,
      code: ev.code ?? ev.key,
      ...(vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
      ...(ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}),
    });
    if (ev.type === "keyDown" && ev.key.length > 1) {
      this.broker.recordHumanAction(id, { at: new Date().toISOString(), kind: "key", key: ev.key });
    }
  }

  async insertText(text: string): Promise<void> {
    const id = this.guard();
    await this.cdp!.send("Input.insertText", { text });
    this.broker.recordHumanAction(id, { at: new Date().toISOString(), kind: "text", text });
  }
}

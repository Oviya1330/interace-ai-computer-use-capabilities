/**
 * Web surface backed by Playwright (Chromium). Perception = screenshot + numbered marks +
 * an accessibility-flavoured element index built by the injected indexer in every frame.
 * Action = DOM-level when a handle is available, coordinates otherwise.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ElementHandle,
  type Frame,
  type Page,
  type Request,
} from "playwright";
import { createHash } from "node:crypto";
import { INDEXER_SCRIPT } from "./indexer.js";
import type {
  DialogPolicyT,
  DialogRecord,
  ElementInfo,
  ExpectationResult,
  FrameInfo,
  Observation,
  Resolved,
  Surface,
} from "./types.js";
import type {
  BBox,
  Expectation,
  SimpleExpectation,
  Target,
  TargetStrategy,
  TargetStrategyKind,
} from "../core/schema.js";
import { interpolate, parameterize, templateToRegex, type Params } from "../core/template.js";
import { RunFailure, errorMessage } from "../core/errors.js";
import { crop, maskRegions } from "./png.js";
import { matchTemplate } from "./visual.js";
import { ulid } from "../core/ids.js";
import { sleep, truncate } from "../core/util.js";

export interface WebSurfaceOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  contentFrame: string[];
  settle: { domQuietMs: number; maxMs: number };
  screenshots: "masked" | "full" | "none";
  /** Regex sources (case-insensitive) matched against labels / column headers / field names. */
  maskPatterns?: string[];
  tracing?: boolean;
  slowMo?: number;
  kind?: "web" | "legacy_web";
}

type RawEntry = Omit<ElementInfo, "ref" | "frame" | "frameIndex" | "bbox">;

const ROLE_STRATEGY_OK = new Set([
  "link",
  "button",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "cell",
  "columnheader",
  "heading",
  "listitem",
  "option",
  "img",
]);

function cssQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function center(b: BBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export class PlaywrightSurface implements Surface {
  readonly kind: "web" | "legacy_web";
  private dialogsSinceObserve: DialogRecord[] = [];
  private dialogsSinceAction: DialogRecord[] = [];
  private expectedDialog: DialogPolicyT | null = null;
  private statusByFrame = new Map<string, number>();
  private lastStatus: number | undefined;
  private pendingNav = new Set<Request>();
  private tracingActive = false;

  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly opts: WebSurfaceOptions,
  ) {
    this.kind = opts.kind ?? "legacy_web";
    page.on("dialog", (d) => {
      const policy = this.expectedDialog;
      const expected = !!policy && new RegExp(policy.messagePattern).test(d.message());
      const response: "accept" | "dismiss" = expected ? policy!.response : "dismiss";
      const rec: DialogRecord = {
        type: d.type(),
        message: d.message(),
        response,
        expected,
        at: new Date().toISOString(),
      };
      this.dialogsSinceObserve.push(rec);
      this.dialogsSinceAction.push(rec);
      void (response === "accept" ? d.accept() : d.dismiss()).catch(() => {});
    });
    page.on("response", (r) => {
      if (r.request().resourceType() === "document") {
        this.lastStatus = r.status();
        const f = r.frame();
        this.statusByFrame.set(this.framePath(f).join("/"), r.status());
      }
    });
    page.on("request", (req) => {
      if (req.isNavigationRequest()) this.pendingNav.add(req);
    });
    const done = (req: Request) => this.pendingNav.delete(req);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  static async launch(opts: WebSurfaceOptions): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: opts.headless, slowMo: opts.slowMo });
    const context = await browser.newContext({ viewport: opts.viewport, ignoreHTTPSErrors: true });
    if (opts.tracing) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = await context.newPage();
    const s = new PlaywrightSurface(browser, context, page, opts);
    s.tracingActive = !!opts.tracing;
    return s;
  }

  // ------------------------------------------------------------------ frames

  private framePath(frame: Frame): string[] {
    const path: string[] = [];
    let cur: Frame | null = frame;
    while (cur && cur.parentFrame()) {
      const parent: Frame = cur.parentFrame()!;
      const name = cur.name() || `#${parent.childFrames().indexOf(cur)}`;
      path.unshift(name);
      cur = parent;
    }
    return path;
  }

  private frameByPath(path: string[]): Frame | null {
    let cur: Frame = this.page.mainFrame();
    for (const seg of path) {
      const kids = cur.childFrames();
      const next = seg.startsWith("#")
        ? kids[Number(seg.slice(1))]
        : kids.find((k) => k.name() === seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  private async frameOffset(frame: Frame): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    try {
      const fe = await frame.frameElement();
      const box = await fe.boundingBox();
      await fe.dispose();
      return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  private async ensureInjected(frame: Frame): Promise<void> {
    await frame.evaluate(INDEXER_SCRIPT.trim().replace(/;$/, ""));
  }

  currentUrl(frame?: string[]): string {
    const f = this.frameByPath(frame ?? this.opts.contentFrame);
    return f?.url() ?? this.page.url();
  }

  // ------------------------------------------------------------------ observe

  async observe(opts: { marks?: boolean; maxReadable?: number } = {}): Promise<Observation> {
    const frames = this.page.frames();
    const frameInfos: FrameInfo[] = [];
    const elements: ElementInfo[] = [];
    const texts: Record<string, string> = {};
    const perFrameEntries: Array<{ frame: Frame; entries: RawEntry[]; refs: string[] }> = [];
    let sig = "";
    let refCounter = 1;

    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      const path = this.framePath(frame);
      const key = path.join("/");
      let entries: RawEntry[] = [];
      let text = "";
      let title = "";
      let frameSig = "";
      try {
        await this.ensureInjected(frame);
        entries = (await frame.evaluate((o) => (window as unknown as CuaWindow).__cua.index(o), {
          maxReadable: opts.maxReadable ?? 150,
          maskPatterns: this.opts.maskPatterns ?? [],
        })) as RawEntry[];
        text = (await frame.evaluate(() =>
          (window as unknown as CuaWindow).__cua.visibleText(),
        )) as string;
        frameSig = (await frame.evaluate(() =>
          (window as unknown as CuaWindow).__cua.signature(),
        )) as string;
        title = await frame.title().catch(() => "");
      } catch {
        // detached / navigating frame: skip this round
        continue;
      }
      const offset = await this.frameOffset(frame);
      frameInfos.push({ path, url: frame.url(), title, offset });
      texts[key] = text;
      sig += frameSig + "\n";
      const refs: string[] = [];
      for (const e of entries) {
        const ref = `e${refCounter++}`;
        refs.push(ref);
        // Classified data never reaches the model's element list or the evidence log.
        if (e.sensitive && this.opts.screenshots !== "full") {
          if (!e.interactive) e.text = "[masked]";
          if (e.value !== undefined && e.role !== "password") e.value = "[masked]";
          e.name = e.interactive ? e.name : "[masked]";
        }
        elements.push({
          ...e,
          ref,
          frame: path,
          frameIndex: frameInfos.length - 1,
          bbox: {
            x: e.localBbox.x + offset.x,
            y: e.localBbox.y + offset.y,
            w: e.localBbox.w,
            h: e.localBbox.h,
          },
        });
      }
      perFrameEntries.push({ frame, entries, refs });
    }

    const sensitiveBoxes = elements.filter((e) => e.sensitive).map((e) => e.bbox);
    const mask = (png: Buffer) =>
      this.opts.screenshots === "masked" ? maskRegions(png, sensitiveBoxes) : png;
    const screenshotPlain = mask(await this.page.screenshot({ type: "png" }));
    let screenshot = screenshotPlain;
    if (opts.marks) {
      for (const { frame, entries, refs } of perFrameEntries) {
        if (entries.length === 0) continue;
        const marks = entries.map((e, i) => ({
          ref: refs[i],
          localBbox: e.localBbox,
          interactive: e.interactive,
        }));
        await frame
          .evaluate((m) => (window as unknown as CuaWindow).__cua.mark(m), marks)
          .catch(() => {});
      }
      screenshot = mask(await this.page.screenshot({ type: "png" }));
      for (const { frame } of perFrameEntries) {
        await frame.evaluate(() => (window as unknown as CuaWindow).__cua.unmark()).catch(() => {});
      }
    }

    const dialogs = this.dialogsSinceObserve;
    this.dialogsSinceObserve = [];
    const landmark = this.pickLandmark(elements);
    const hash = createHash("sha1")
      .update(this.page.url() + "\n" + sig)
      .digest("hex")
      .slice(0, 16);
    return {
      id: ulid(),
      at: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      frames: frameInfos,
      elements,
      screenshot,
      screenshotPlain,
      dialogs,
      lastStatus: this.lastStatus,
      texts,
      hash,
      landmark,
    };
  }

  private pickLandmark(elements: ElementInfo[]): string | undefined {
    const key = this.opts.contentFrame.join("/");
    let best: { score: number; text: string } | undefined;
    for (const e of elements) {
      if (e.frame.join("/") !== key || e.interactive || !e.text || e.text.length > 60) continue;
      const score = (e.fontSize ?? 0) + (e.bold ? 2 : 0) + (e.role === "heading" ? 4 : 0);
      if (score >= 15 && (!best || score > best.score)) best = { score, text: e.text };
    }
    return best?.text;
  }

  // ------------------------------------------------------------------ resolve

  async resolveRef(obs: Observation, ref: string): Promise<Resolved> {
    const el = obs.elements.find((e) => e.ref === ref);
    if (!el) throw new RunFailure("TARGET_NOT_FOUND", `Unknown element ref ${ref}`);
    const frame = this.frameByPath(el.frame);
    if (!frame) throw new RunFailure("TARGET_NOT_FOUND", `Frame ${el.frame.join("/")} is gone`);
    const started = Date.now();
    const jsh = await frame.evaluateHandle(
      (i) => (window as unknown as CuaWindow).__cua.elementAt(i),
      el.index,
    );
    const handle = jsh.asElement();
    if (!handle) throw new RunFailure("TARGET_NOT_FOUND", `Element ${ref} is stale (page changed)`);
    return {
      element: el,
      frame: el.frame,
      point: center(el.bbox),
      handle,
      resolution: { strategy: "ref", tier: 0, matches: 1, ms: Date.now() - started },
    };
  }

  async resolve(
    target: Target,
    params: Params,
    opts: {
      timeoutMs?: number;
      allowedKinds?: TargetStrategyKind[];
      preferKinds?: TargetStrategyKind[];
    } = {},
  ): Promise<Resolved> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const started = Date.now();
    const tried = new Map<string, string>();
    let ambiguous = false;
    const allowed = opts.allowedKinds ? new Set(opts.allowedKinds) : null;
    // The artifact's order is the default; an explicit preference reorders (tier stays the
    // artifact index so drift reporting keeps its meaning).
    const indexed = target.strategies.map((strategy, tier) => ({ strategy, tier }));
    const order = opts.preferKinds;
    const attempts = order
      ? [...indexed].sort((a, b) => order.indexOf(a.strategy.kind) - order.indexOf(b.strategy.kind))
      : indexed;

    while (true) {
      const frame = this.frameByPath(target.frame);
      if (frame) {
        try {
          await this.ensureInjected(frame);
        } catch {
          /* frame navigating */
        }
        for (const { strategy, tier } of attempts) {
          if (
            (allowed && !allowed.has(strategy.kind)) ||
            (order && !order.includes(strategy.kind))
          ) {
            tried.set(strategy.kind, "not allowed by locator policy");
            continue;
          }
          let found: { handles: ElementHandle[]; point?: { x: number; y: number } };
          try {
            found = await this.resolveStrategy(frame, strategy, params);
          } catch (e) {
            tried.set(strategy.kind, `error: ${truncate(errorMessage(e), 120)}`);
            continue;
          }
          const visible: ElementHandle[] = [];
          for (const h of found.handles) {
            if (await h.isVisible().catch(() => false)) visible.push(h);
          }
          if (visible.length === 1 || (visible.length === 0 && found.point)) {
            const handle = visible[0];
            let element: ElementInfo | null = null;
            let point = found.point ?? { x: 0, y: 0 };
            if (handle) {
              const offset = await this.frameOffset(frame);
              const entry = (await handle.evaluate((el) =>
                (window as unknown as CuaWindow).__cua.register(el as Element),
              )) as RawEntry;
              element = {
                ...entry,
                ref: "resolved",
                frame: target.frame,
                frameIndex: -1,
                bbox: {
                  x: entry.localBbox.x + offset.x,
                  y: entry.localBbox.y + offset.y,
                  w: entry.localBbox.w,
                  h: entry.localBbox.h,
                },
              };
              point = center(element.bbox);
            }
            return {
              element,
              frame: target.frame,
              point,
              handle,
              resolution: { strategy: strategy.kind, tier, matches: 1, ms: Date.now() - started },
            };
          }
          if (visible.length > 1) {
            ambiguous = true;
            tried.set(strategy.kind, `${visible.length} visible matches`);
          } else {
            tried.set(strategy.kind, "no match");
          }
        }
      } else {
        tried.set("frame", `frame ${JSON.stringify(target.frame)} not present`);
      }
      if (Date.now() - started > timeoutMs) break;
      await sleep(200);
    }
    const observed = [...tried.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
    throw new RunFailure(
      ambiguous ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
      `Could not resolve ${target.description} within ${timeoutMs}ms`,
      { expected: `one visible element matching ${target.description}`, observed },
    );
  }

  private async resolveStrategy(
    frame: Frame,
    s: TargetStrategy,
    params: Params,
  ): Promise<{ handles: ElementHandle[]; point?: { x: number; y: number } }> {
    const cua = (fn: string, arg: unknown): Promise<ElementHandle[]> =>
      this.arrayHandles(frame, fn, arg);
    switch (s.kind) {
      case "role": {
        const loc = frame.getByRole(s.role as Parameters<Frame["getByRole"]>[0], {
          ...(s.name !== undefined ? { name: interpolate(s.name, params) } : {}),
          exact: s.exact ?? true,
        });
        return { handles: await loc.elementHandles() };
      }
      case "label":
        return {
          handles: await cua("findByLabel", [interpolate(s.text, params), s.control ?? "any"]),
        };
      case "text":
        return {
          handles: await cua("findByText", [
            interpolate(s.text, params),
            s.tag ?? null,
            s.exact ?? true,
          ]),
        };
      case "attr": {
        const sel =
          (s.tag ?? "") +
          Object.entries(s.attrs)
            .map(([k, v]) => `[${k}=${cssQuote(interpolate(v, params))}]`)
            .join("");
        return { handles: await frame.$$(sel) };
      }
      case "table": {
        const spec = {
          headers: s.headers.map((h) => interpolate(h, params)),
          row: s.row
            ? {
                column: interpolate(s.row.column, params),
                equals: interpolate(s.row.equals, params),
              }
            : undefined,
          rowIndex: s.rowIndex,
          column: interpolate(s.column, params),
          inner: s.inner ?? "cell",
        };
        return { handles: await cua("findTableCell", [spec]) };
      }
      case "css":
        return { handles: await frame.$$(s.selector) };
      case "xpath":
        return { handles: await frame.$$(`xpath=${s.expression}`) };
      case "visual": {
        const shot = await this.page.screenshot({ type: "png" });
        const m = matchTemplate(shot, Buffer.from(s.template, "base64"), s.bbox, {
          threshold: s.threshold,
        });
        if (!m) return { handles: [] };
        const point = { x: m.x + m.w / 2, y: m.y + m.h / 2 };
        const offset = await this.frameOffset(frame);
        const local = { x: point.x - offset.x, y: point.y - offset.y };
        const jsh = await frame.evaluateHandle(
          ({ x, y }) => document.elementFromPoint(x, y),
          local,
        );
        const h = jsh.asElement();
        return { handles: h ? [h] : [], point };
      }
    }
  }

  private async arrayHandles(frame: Frame, fn: string, args: unknown): Promise<ElementHandle[]> {
    const jsh = await frame.evaluateHandle(
      ({ fn, args }) => {
        const api = (window as unknown as CuaWindow).__cua as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        return api[fn]!(...(args as unknown[]));
      },
      { fn, args },
    );
    const props = await jsh.getProperties();
    const out: ElementHandle[] = [];
    for (const v of props.values()) {
      const el = v.asElement();
      if (el) out.push(el);
    }
    await jsh.dispose();
    return out;
  }

  // ------------------------------------------------------------------ describe (recorder)

  describeTarget(el: ElementInfo, params: Params, screenshotPlain: Buffer): Target {
    const strategies: TargetStrategy[] = [];
    const role = el.role;
    const isControl = ["textbox", "password", "combobox", "checkbox", "radio", "file"].includes(
      role,
    );
    const isButtonish = role === "button" || role === "link";
    const isCell = el.tag === "td" || el.tag === "th";
    const text = el.text || el.attrs.value || "";
    const pText = parameterize(text, params);
    const textParameterised = pText !== text;
    const valueLike = /\d/.test(text) && !textParameterised;

    // Key/value table ("Confirmation Number | CNF-…"): the label cell is the stable anchor.
    const kv =
      isCell &&
      !!el.labelText &&
      !!el.table &&
      el.table.rowCells.length === 2 &&
      el.table.colIndex === 1;
    if (kv) strategies.push({ kind: "label", text: el.labelText!, control: "value" });

    let table: TargetStrategy | undefined;
    if (el.table && !el.table.isHeader && el.table.columnHeader && !kv) {
      const t = el.table;
      const headers = t.headers.filter(Boolean);
      if (headers.length >= 2) {
        let row: { column: string; equals: string } | undefined;
        for (let i = 0; i < t.rowCells.length; i++) {
          const h = t.headers[i];
          const v = t.rowCells[i];
          if (!h || !v) continue;
          const pv = parameterize(v, params);
          if (pv !== v) {
            row = { column: h, equals: pv };
            break;
          }
        }
        if (!row) {
          for (let i = 0; i < t.rowCells.length; i++) {
            const h = t.headers[i];
            const v = t.rowCells[i];
            if (i === t.colIndex || !h || !v || /\d/.test(v) || v.length > 40) continue;
            row = { column: h, equals: v };
            break;
          }
        }
        table = {
          kind: "table",
          headers,
          ...(row ? { row } : { rowIndex: t.dataRowIndex }),
          column: t.columnHeader,
          inner: el.tag === "a" ? "link" : isControl ? "control" : "cell",
        };
      }
    }

    const tableFirst = isCell && !isButtonish;
    if (table && tableFirst) strategies.push(table);
    if (ROLE_STRATEGY_OK.has(role) && el.name && el.name.length <= 80 && !(isCell && valueLike)) {
      strategies.push({ kind: "role", role, name: parameterize(el.name, params), exact: true });
    }
    if (isControl && el.labelText) {
      const control =
        role === "password" ? "textbox" : (role as "textbox" | "combobox" | "checkbox" | "radio");
      if (!isControl && !kv) throw new Error("unreachable");
      strategies.push({ kind: "label", text: el.labelText, control });
    }
    if (text && text.length <= 80 && !isControl && !(isCell && valueLike)) {
      strategies.push({ kind: "text", text: pText, tag: el.tag, exact: true });
    }
    if (table && !tableFirst) strategies.push(table);
    const attrs: Record<string, string> = {};
    if (el.attrs.id) attrs.id = el.attrs.id;
    if (el.attrs.name) attrs.name = el.attrs.name;
    if (el.attrs.type) attrs.type = el.attrs.type;
    if (isButtonish && el.attrs.value) attrs.value = el.attrs.value;
    if (el.tag === "a" && el.attrs.href) attrs.href = parameterize(el.attrs.href, params);
    if (Object.keys(attrs).length) strategies.push({ kind: "attr", tag: el.tag, attrs });
    strategies.push({ kind: "css", selector: el.css });
    strategies.push({ kind: "xpath", expression: el.xpath });
    const area = el.bbox.w * el.bbox.h;
    if (
      !textParameterised &&
      !el.sensitive &&
      !(isCell && valueLike) &&
      area <= 40_000 &&
      el.bbox.w >= 8 &&
      el.bbox.h >= 8
    ) {
      const c = crop(screenshotPlain, el.bbox);
      if (c)
        strategies.push({
          kind: "visual",
          bbox: el.bbox,
          template: c.toString("base64"),
          threshold: 0.92,
        });
    }

    const roleWord = role === "text" ? el.tag : role;
    const frameSuffix = el.frame.length ? ` in frame ${el.frame.join("/")}` : "";
    let description: string;
    if (kv) {
      description = `the value next to "${el.labelText}"${frameSuffix}`;
    } else if (isCell && valueLike && table && table.kind === "table") {
      description = `the "${table.column}" cell${table.row ? ` of the row where ${table.row.column} = "${table.row.equals}"` : ` of data row ${table.rowIndex}`}${frameSuffix}`;
    } else {
      const label = el.name || el.labelText || text || el.attrs.name || el.tag;
      description = `the ${roleWord} "${truncate(parameterize(label, params), 60)}"${frameSuffix}`;
    }
    const recordedName =
      isCell && valueLike ? undefined : el.name ? parameterize(el.name, params) : undefined;
    return {
      description,
      frame: el.frame,
      strategies,
      recorded: { tag: el.tag, role, name: recordedName, bbox: el.bbox },
    };
  }

  // ------------------------------------------------------------------ act

  private handleOf(r: Resolved): ElementHandle | undefined {
    return r.handle as ElementHandle | undefined;
  }

  async click(r: Resolved): Promise<void> {
    this.dialogsSinceAction = [];
    const h = this.handleOf(r);
    if (h) {
      try {
        await h.click({ timeout: 5000 });
        return;
      } catch (e) {
        if (!(await h.isVisible().catch(() => false)))
          throw new RunFailure("SURFACE_ERROR", `click failed: ${errorMessage(e)}`);
      }
    }
    await this.page.mouse.click(r.point.x, r.point.y);
  }

  async type(
    r: Resolved,
    text: string,
    opts: { clear?: boolean; pressEnter?: boolean } = {},
  ): Promise<void> {
    this.dialogsSinceAction = [];
    const h = this.handleOf(r);
    if (h) {
      if (opts.clear === false) {
        await h.focus();
        await this.page.keyboard.type(text);
      } else {
        await h.fill(text);
      }
      if (opts.pressEnter) await h.press("Enter");
      return;
    }
    await this.page.mouse.click(r.point.x, r.point.y);
    if (opts.clear !== false) await this.page.keyboard.press("ControlOrMeta+a");
    await this.page.keyboard.type(text);
    if (opts.pressEnter) await this.page.keyboard.press("Enter");
  }

  async select(r: Resolved, value: string): Promise<void> {
    this.dialogsSinceAction = [];
    const h = this.handleOf(r);
    if (!h) throw new RunFailure("SURFACE_ERROR", "select requires an element handle");
    try {
      await h.selectOption({ label: value });
    } catch {
      await h.selectOption(value);
    }
  }

  async press(key: string): Promise<void> {
    this.dialogsSinceAction = [];
    await this.page.keyboard.press(key);
  }

  async navigate(url: string): Promise<void> {
    this.dialogsSinceAction = [];
    this.statusByFrame.clear();
    try {
      await this.page.goto(url, { waitUntil: "load", timeout: 30_000 });
    } catch (e) {
      throw new RunFailure("NAVIGATION_ERROR", `navigate to ${url} failed: ${errorMessage(e)}`);
    }
  }

  async readText(r: Resolved): Promise<string> {
    const h = this.handleOf(r);
    if (!h) throw new RunFailure("SURFACE_ERROR", "readText requires an element handle");
    const t = (await h.evaluate((el) => {
      const e = el as HTMLElement & {
        value?: string;
        selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
      };
      if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") return e.value ?? "";
      if (e.tagName === "SELECT") return e.selectedOptions?.[0]?.textContent ?? "";
      return e.innerText ?? e.textContent ?? "";
    })) as string;
    return t.replace(/\s+/g, " ").trim();
  }

  async clickAt(x: number, y: number): Promise<void> {
    this.dialogsSinceAction = [];
    await this.page.mouse.click(x, y);
  }

  // ------------------------------------------------------------------ expectations

  async check(
    e: Expectation,
    params: Params,
    opts: { timeoutMs?: number } = {},
  ): Promise<ExpectationResult> {
    const timeoutMs = opts.timeoutMs ?? 0;
    const started = Date.now();
    let last: ExpectationResult = { ok: false, observed: "" };

    while (true) {
      last = await this.evaluate(e, params);
      if (last.ok || Date.now() - started >= timeoutMs) return last;
      await sleep(200);
    }
  }

  private async evaluate(e: Expectation, params: Params): Promise<ExpectationResult> {
    if (e.kind === "all" || e.kind === "any") {
      const results = await Promise.all(e.of.map((x) => this.evaluateSimple(x, params)));
      const ok = e.kind === "all" ? results.every((r) => r.ok) : results.some((r) => r.ok);
      return { ok, observed: results.map((r) => r.observed).join(" | ") };
    }
    return this.evaluateSimple(e, params);
  }

  private async frameText(path: string[] | undefined): Promise<string> {
    const frames = path
      ? [this.frameByPath(path)].filter((f): f is Frame => !!f)
      : this.page.frames();
    const parts: string[] = [];
    for (const f of frames) {
      try {
        await this.ensureInjected(f);
        parts.push(
          (await f.evaluate(() => (window as unknown as CuaWindow).__cua.visibleText())) as string,
        );
      } catch {
        /* skip detached */
      }
    }
    return parts.join("\n");
  }

  private async evaluateSimple(e: SimpleExpectation, params: Params): Promise<ExpectationResult> {
    switch (e.kind) {
      case "url": {
        const url = this.currentUrl(e.frame);
        const re = templateToRegex(e.pattern, params);
        return { ok: re.test(url), observed: `url=${url}` };
      }
      case "text": {
        const text = await this.frameText(e.frame);
        const want = interpolate(e.text, params);
        const matched = e.regex ? new RegExp(want, "i").test(text) : text.includes(want);
        const present = e.present ?? true;
        return {
          ok: matched === present,
          observed: matched
            ? `text "${truncate(want, 60)}" present`
            : `text "${truncate(want, 60)}" absent`,
        };
      }
      case "title": {
        const t = await this.page.title().catch(() => "");
        return { ok: templateToRegex(e.pattern, params).test(t), observed: `title=${t}` };
      }
      case "target": {
        try {
          const r = await this.resolve(e.target, params, { timeoutMs: 0 });
          if (e.state === "hidden")
            return { ok: false, observed: `${e.target.description} is visible` };
          if (e.state === "enabled") {
            const h = this.handleOf(r);
            const enabled = h ? await h.isEnabled().catch(() => false) : true;
            return {
              ok: enabled,
              observed: `${e.target.description} ${enabled ? "enabled" : "disabled"}`,
            };
          }
          return { ok: true, observed: `${e.target.description} visible` };
        } catch {
          return { ok: e.state === "hidden", observed: `${e.target.description} not found` };
        }
      }
      case "http_status": {
        const status =
          this.statusByFrame.get(this.opts.contentFrame.join("/")) ?? this.lastStatus ?? 0;
        const ok =
          (e.min === undefined || status >= e.min) && (e.max === undefined || status <= e.max);
        return { ok, observed: `http_status=${status}` };
      }
      case "dialog": {
        const hit = this.dialogsSinceAction.find(
          (d) => !e.messagePattern || new RegExp(e.messagePattern).test(d.message),
        );
        return { ok: !!hit, observed: hit ? `dialog "${truncate(hit.message, 60)}"` : "no dialog" };
      }
    }
  }

  // ------------------------------------------------------------------ misc

  async settle(): Promise<void> {
    const { domQuietMs, maxMs } = this.opts.settle;
    const started = Date.now();
    await this.page.waitForLoadState("load", { timeout: 1500 }).catch(() => {});
    let lastSig = "";
    let stableSince = Date.now();
    while (Date.now() - started < maxMs) {
      let sig = "";
      let allComplete = this.pendingNav.size === 0;
      for (const f of this.page.frames()) {
        try {
          const r = (await f.evaluate(
            () =>
              document.readyState +
              "|" +
              location.href +
              "|" +
              (document.body ? document.body.innerText.length : 0) +
              "|" +
              document.querySelectorAll("*").length,
          )) as string;
          if (!r.startsWith("complete")) allComplete = false;
          sig += r + ";";
        } catch {
          allComplete = false;
        }
      }
      if (sig !== lastSig) {
        lastSig = sig;
        stableSince = Date.now();
      } else if (allComplete && Date.now() - stableSince >= domQuietMs) {
        return;
      }
      await sleep(100);
    }
  }

  async screenshot(): Promise<Buffer> {
    const png = await this.page.screenshot({ type: "png" });
    if (this.opts.screenshots !== "masked") return png;
    return maskRegions(png, await this.sensitiveBoxes());
  }

  private async sensitiveBoxes(): Promise<BBox[]> {
    const boxes: BBox[] = [];
    for (const f of this.page.frames()) {
      try {
        const local = (await f.evaluate(() =>
          [...document.querySelectorAll('input[type="password"]')].map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
          }),
        )) as BBox[];
        if (local.length === 0) continue;
        const off = await this.frameOffset(f);
        for (const b of local) boxes.push({ x: b.x + off.x, y: b.y + off.y, w: b.w, h: b.h });
      } catch {
        /* skip */
      }
    }
    return boxes;
  }

  async domSnapshot(): Promise<string> {
    const parts: string[] = [];
    for (const f of this.page.frames()) {
      try {
        const html = (await f.evaluate(() => document.documentElement.outerHTML)) as string;
        parts.push(`<!-- frame: /${this.framePath(f).join("/")} url: ${f.url()} -->\n${html}`);
      } catch {
        parts.push(`<!-- frame: /${this.framePath(f).join("/")} (detached) -->`);
      }
    }
    return parts
      .join("\n\n")
      .replace(
        /(<input[^>]*type=["']?password["']?[^>]*value=["'])[^"']*(["'])/gi,
        "$1[REDACTED]$2",
      );
  }

  takeDialogs(): DialogRecord[] {
    const d = this.dialogsSinceAction;
    this.dialogsSinceAction = [];
    return d;
  }

  expectDialog(policy: DialogPolicyT | null): void {
    this.expectedDialog = policy;
  }

  async cdp(): Promise<CDPSession> {
    return this.context.newCDPSession(this.page);
  }

  /** Describe the element under a page-global point (used to record human actions). */
  async describeAt(x: number, y: number): Promise<ElementInfo | null> {
    let best: { frame: Frame; offset: { x: number; y: number }; depth: number } | null = null;
    for (const f of this.page.frames()) {
      const path = this.framePath(f);
      if (path.length === 0) {
        if (!best) best = { frame: f, offset: { x: 0, y: 0 }, depth: 0 };
        continue;
      }
      let box: BBox | null = null;
      try {
        const fe = await f.frameElement();
        const b = await fe.boundingBox();
        await fe.dispose();
        if (b) box = { x: b.x, y: b.y, w: b.width, h: b.height };
      } catch {
        continue;
      }
      if (box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
        if (!best || path.length > best.depth)
          best = { frame: f, offset: { x: box.x, y: box.y }, depth: path.length };
      }
    }
    if (!best) return null;
    try {
      await this.ensureInjected(best.frame);
      const entry = (await best.frame.evaluate(
        ({ x, y }) => (window as unknown as CuaWindow).__cua.describeAt(x, y),
        { x: x - best.offset.x, y: y - best.offset.y },
      )) as RawEntry | null;
      if (!entry) return null;
      const path = this.framePath(best.frame);
      return {
        ...entry,
        ref: "human",
        frame: path,
        frameIndex: -1,
        bbox: {
          x: entry.localBbox.x + best.offset.x,
          y: entry.localBbox.y + best.offset.y,
          w: entry.localBbox.w,
          h: entry.localBbox.h,
        },
      };
    } catch {
      return null;
    }
  }

  async stopTrace(file: string): Promise<boolean> {
    if (!this.tracingActive) return false;
    this.tracingActive = false;
    await this.context.tracing.stop({ path: file });
    return true;
  }

  async close(): Promise<void> {
    if (this.tracingActive) {
      this.tracingActive = false;
      await this.context.tracing.stop().catch(() => {});
    }
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

/** Shape of the injected indexer API (browser side). */
interface CuaWindow {
  __cua: {
    index(opts: { maxReadable: number; maskPatterns: string[] }): unknown;
    elementAt(i: number): Element | null;
    register(el: Element): unknown;
    describeAt(x: number, y: number): unknown;
    mark(entries: unknown): void;
    unmark(): void;
    visibleText(): string;
    signature(): string;
  };
}

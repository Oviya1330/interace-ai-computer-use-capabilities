/**
 * The surface seam: everything the discovery agent and the replay engine know about
 * "how we perceive and act on an application". A web (Playwright) implementation is provided;
 * a desktop implementation would expose the same Observation/Resolved shapes built from the
 * OS accessibility tree and screenshots.
 */
import type {
  BBox,
  DialogPolicy,
  Expectation,
  Target,
  TargetStrategyKind,
} from "../core/schema.js";
import type { Params } from "../core/template.js";
import type { Resolution } from "../core/result.js";
import type { z } from "zod";

export interface TableContext {
  headers: string[];
  headerRowIndex: number;
  rowIndex: number;
  /** Index among data rows (after the header row). */
  dataRowIndex: number;
  colIndex: number;
  columnHeader: string;
  rowCells: string[];
  isHeader: boolean;
}

export interface ElementInfo {
  /** Observation-scoped handle, e.g. "e12". */
  ref: string;
  frame: string[];
  frameIndex: number;
  /** Index in the frame's element registry (for handle lookup). */
  index: number;
  tag: string;
  role: string;
  /** True accessible name (ARIA / label / value / alt / title / placeholder). */
  name: string;
  /** Own visible text. */
  text: string;
  value?: string;
  attrs: Record<string, string>;
  /** Heuristic label for legacy layouts (adjacent cell text etc.). */
  labelText?: string;
  /** Page-global bbox (main-frame viewport coordinates). */
  bbox: BBox;
  /** Frame-local bbox. */
  localBbox: BBox;
  interactive: boolean;
  disabled: boolean;
  sensitive: boolean;
  table?: TableContext;
  css: string;
  xpath: string;
  formSubmitLabels?: string[];
  fontSize?: number;
  bold?: boolean;
}

export interface FrameInfo {
  path: string[];
  url: string;
  title: string;
  offset: { x: number; y: number };
}

export interface DialogRecord {
  type: string;
  message: string;
  response: "accept" | "dismiss";
  expected: boolean;
  at: string;
}

export interface Observation {
  id: string;
  at: string;
  url: string;
  title: string;
  frames: FrameInfo[];
  elements: ElementInfo[];
  /** PNG, masked per data policy, with numbered marks when requested. */
  screenshot: Buffer;
  /** PNG, masked per data policy, no marks. */
  screenshotPlain: Buffer;
  /** Dialogs raised since the previous observation. */
  dialogs: DialogRecord[];
  lastStatus?: number;
  /** Visible text per frame, keyed by frame path joined with "/". */
  texts: Record<string, string>;
  /** State fingerprint for stuck detection. */
  hash: string;
  /** Heading-like text of the content frame. */
  landmark?: string;
}

export interface Resolved {
  element: ElementInfo | null;
  frame: string[];
  point: { x: number; y: number };
  /** Surface-specific handle (Playwright ElementHandle for the web surface). */
  handle?: unknown;
  resolution: Resolution;
}

export interface ExpectationResult {
  ok: boolean;
  observed: string;
}

export type DialogPolicyT = z.infer<typeof DialogPolicy>;

export interface Surface {
  readonly kind: "web" | "legacy_web" | "desktop";
  observe(opts?: { marks?: boolean; maxReadable?: number }): Promise<Observation>;
  resolve(
    target: Target,
    params: Params,
    opts?: {
      timeoutMs?: number;
      /** Only these strategy kinds may be used (profile locator policy). */
      allowedKinds?: TargetStrategyKind[];
      /** Try strategies in THIS order instead of the artifact's (an explicit locator preference). */
      preferKinds?: TargetStrategyKind[];
    },
  ): Promise<Resolved>;
  resolveRef(obs: Observation, ref: string): Promise<Resolved>;
  /** Build a multi-strategy Target for an observed element (used by the recorder). */
  describeTarget(el: ElementInfo, params: Params, screenshotPlain: Buffer): Target;
  click(r: Resolved): Promise<void>;
  type(r: Resolved, text: string, opts?: { clear?: boolean; pressEnter?: boolean }): Promise<void>;
  select(r: Resolved, value: string): Promise<void>;
  press(key: string): Promise<void>;
  navigate(url: string): Promise<void>;
  readText(r: Resolved): Promise<string>;
  check(e: Expectation, params: Params, opts?: { timeoutMs?: number }): Promise<ExpectationResult>;
  settle(): Promise<void>;
  screenshot(): Promise<Buffer>;
  domSnapshot(): Promise<string>;
  takeDialogs(): DialogRecord[];
  expectDialog(policy: DialogPolicyT | null): void;
  currentUrl(frame?: string[]): string;
  close(): Promise<void>;
}

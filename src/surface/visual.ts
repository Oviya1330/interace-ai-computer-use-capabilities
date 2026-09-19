/**
 * Visual fallback locator: normalised cross-correlation of a recorded control crop against
 * the current screenshot, searched in a window around where the control used to be.
 * This is the strategy a screenshot-only surface (desktop) would rely on.
 */
import type { BBox } from "../core/schema.js";
import { decode, toGray, type Gray } from "./png.js";

export interface VisualMatch {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

function stats(
  g: Gray,
  x0: number,
  y0: number,
  w: number,
  h: number,
): { mean: number; norm: number } {
  let sum = 0;
  let sq = 0;
  for (let y = 0; y < h; y++) {
    const row = (y0 + y) * g.width + x0;
    for (let x = 0; x < w; x++) {
      const v = g.data[row + x]!;
      sum += v;
      sq += v * v;
    }
  }
  const n = w * h;
  const mean = sum / n;
  return { mean, norm: Math.sqrt(Math.max(sq - n * mean * mean, 1e-6)) };
}

export function matchTemplate(
  screenshot: Buffer,
  template: Buffer,
  hint: BBox,
  opts: { window?: number; threshold?: number } = {},
): VisualMatch | null {
  const win = opts.window ?? 160;
  const threshold = opts.threshold ?? 0.92;
  const S = toGray(decode(screenshot));
  const T = toGray(decode(template));
  if (T.width > S.width || T.height > S.height) return null;

  const tStats = stats(T, 0, 0, T.width, T.height);
  const tCentered = new Float32Array(T.width * T.height);
  for (let i = 0; i < tCentered.length; i++) tCentered[i] = T.data[i]! - tStats.mean;

  const xMin = Math.max(0, Math.floor(hint.x) - win);
  const yMin = Math.max(0, Math.floor(hint.y) - win);
  const xMax = Math.min(S.width - T.width, Math.ceil(hint.x) + win);
  const yMax = Math.min(S.height - T.height, Math.ceil(hint.y) + win);

  let best: VisualMatch | null = null;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const s = stats(S, x, y, T.width, T.height);
      let dot = 0;
      for (let ty = 0; ty < T.height; ty++) {
        const sRow = (y + ty) * S.width + x;
        const tRow = ty * T.width;
        for (let tx = 0; tx < T.width; tx++) {
          dot += (S.data[sRow + tx]! - s.mean) * tCentered[tRow + tx]!;
        }
      }
      const score = dot / (s.norm * tStats.norm);
      if (!best || score > best.score) best = { x, y, w: T.width, h: T.height, score };
      if (score > 0.995) return best;
    }
  }
  return best && best.score >= threshold ? best : null;
}

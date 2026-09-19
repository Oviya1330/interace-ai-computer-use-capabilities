import { PNG } from "pngjs";
import type { BBox } from "../core/schema.js";

export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export function decode(png: Buffer): PNG {
  return PNG.sync.read(png);
}

export function encode(img: PNG): Buffer {
  return PNG.sync.write(img);
}

export function toGray(img: PNG): Gray {
  const { width, height, data } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  }
  return { width, height, data: out };
}

/** Black out regions (used to mask password fields / sensitive controls in evidence). */
export function maskRegions(png: Buffer, boxes: BBox[]): Buffer {
  if (boxes.length === 0) return png;
  const img = decode(png);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(img.width, Math.ceil(b.x + b.w));
    const y1 = Math.min(img.height, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * img.width + x) * 4;
        img.data[p] = 20;
        img.data[p + 1] = 20;
        img.data[p + 2] = 20;
        img.data[p + 3] = 255;
      }
    }
  }
  return encode(img);
}

export function crop(png: Buffer, b: BBox, pad = 2): Buffer | null {
  const img = decode(png);
  const x0 = Math.max(0, Math.floor(b.x) - pad);
  const y0 = Math.max(0, Math.floor(b.y) - pad);
  const x1 = Math.min(img.width, Math.ceil(b.x + b.w) + pad);
  const y1 = Math.min(img.height, Math.ceil(b.y + b.h) + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    img.data.copy(out.data, y * w * 4, src, src + w * 4);
  }
  return encode(out);
}

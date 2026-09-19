import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** ULID-style id: time-sortable, 26 chars. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[rnd[i]! % 32];
  return time + rand;
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

import { randomBytes } from "node:crypto";
import type { TenantId } from "./data.js";

export interface Session {
  id: string;
  user: string;
  tenant: TenantId;
  createdAt: number;
  lastSeen: number;
  noticeAcked: boolean;
}

export const SESSION_COOKIE = "LCSESSID";

export function sessionTimeoutMs(): number {
  const raw = process.env.LEGACYCORE_SESSION_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1_800_000;
}

/** In-memory session store with idle timeout (legacy apps do exactly this, minus the memory leak). */
export class SessionStore {
  private sessions = new Map<string, Session>();

  create(user: string, tenant: TenantId): Session {
    const now = Date.now();
    const s: Session = {
      id: randomBytes(16).toString("hex"),
      user,
      tenant,
      createdAt: now,
      lastSeen: now,
      noticeAcked: false,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Returns the session if it exists and has not idled out; touches `lastSeen`. */
  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > sessionTimeoutMs()) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  reset(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Hash-chained audit log of control-plane events: interventions raised, control transfers,
 * human actions, resolutions, invocation approvals and ledger commits. Each entry carries the
 * hash of the previous one, so removal or edit of any entry is detectable (`cua audit verify`).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  seq: number;
  at: string;
  type: string;
  runId?: string;
  actor: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function hashOf(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

export class AuditLog {
  private last: { seq: number; hash: string } = { seq: -1, hash: GENESIS };

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
    const entries = AuditLog.read(file);
    const tail = entries[entries.length - 1];
    if (tail) this.last = { seq: tail.seq, hash: tail.hash };
  }

  static read(file: string): AuditEntry[] {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
  }

  record(type: string, actor: string, data: Record<string, unknown>, runId?: string): AuditEntry {
    const base: Omit<AuditEntry, "hash"> = {
      seq: this.last.seq + 1,
      at: new Date().toISOString(),
      type,
      ...(runId ? { runId } : {}),
      actor,
      data,
      prevHash: this.last.hash,
    };
    const entry: AuditEntry = { ...base, hash: hashOf(base) };
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    this.last = { seq: entry.seq, hash: entry.hash };
    return entry;
  }

  /** Verify the chain; returns the first broken sequence number, or null when intact. */
  static verify(file: string): { ok: boolean; entries: number; brokenAt: number | null } {
    const entries = AuditLog.read(file);
    let prev = GENESIS;
    for (const [i, e] of entries.entries()) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || hashOf(rest) !== hash || e.seq !== i)
        return { ok: false, entries: entries.length, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, entries: entries.length, brokenAt: null };
  }
}

/**
 * Idempotency ledger for irreversible steps. Before an irreversible action runs, the engine
 * records an INTENT keyed by the caller's idempotency key; after it, a COMMITTED (or FAILED)
 * entry. A repeat invocation with the same key then returns the earlier result instead of
 * posting twice, and an INTENT with no outcome (a crash mid-commit) is escalated to a human
 * because nobody can know whether the post happened. Append-only JSONL; a database in production.
 */
import fs from "node:fs";
import path from "node:path";

export type LedgerStatus = "intent" | "committed" | "failed" | "unknown";

export interface LedgerEntry {
  at: string;
  key: string;
  capability: string;
  version: string;
  tenant: string;
  stepId: string;
  runId: string;
  status: LedgerStatus;
  /** Declared outputs known at commit time (e.g. a confirmation number). */
  outputs?: Record<string, unknown>;
  note?: string;
}

export class IdempotencyLedger {
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  }

  private read(): LedgerEntry[] {
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  /** Latest entry for a key + step, if any. */
  lookup(key: string, capability: string, stepId: string): LedgerEntry | null {
    const entries = this.read().filter(
      (e) => e.key === key && e.capability === capability && e.stepId === stepId,
    );
    return entries[entries.length - 1] ?? null;
  }

  /** Any committed outputs for a key on this capability (for DUPLICATE_INVOCATION responses). */
  committedOutputs(key: string, capability: string): Record<string, unknown> | null {
    const entries = this.read().filter(
      (e) => e.key === key && e.capability === capability && e.status === "committed",
    );
    return entries.length ? (entries[entries.length - 1]!.outputs ?? {}) : null;
  }

  append(entry: Omit<LedgerEntry, "at">): LedgerEntry {
    const full: LedgerEntry = { at: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }
}

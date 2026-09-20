/**
 * Tamper evidence for artifacts. The hash covers the parts that change replay behaviour
 * (contract, steps, checkpoint, conditions, overrides, provenance) and excludes the mutable
 * bookkeeping (integrity itself, review, status, stats). An approval records the hash it was
 * given for; if the content changes afterwards the approval no longer applies.
 */
import { createHash } from "node:crypto";
import type { Capability } from "../core/schema.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(cap: Capability): string {
  const { integrity: _i, review: _r, status: _s, stats: _st, ...rest } = cap;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

export function withIntegrity(cap: Capability): Capability {
  return { ...cap, integrity: { algorithm: "sha256", hash: contentHash(cap) } };
}

export interface IntegrityCheck {
  hash: string;
  storedHashMatches: boolean | null;
  approvedHashMatches: boolean | null;
  /** The status replay must honour: an edited "approved" artifact is treated as draft. */
  effectiveStatus: Capability["status"];
  problems: string[];
}

export function checkIntegrity(cap: Capability): IntegrityCheck {
  const hash = contentHash(cap);
  const problems: string[] = [];
  const storedHashMatches = cap.integrity ? cap.integrity.hash === hash : null;
  if (storedHashMatches === false)
    problems.push("stored integrity hash does not match the content (edited after save?)");
  const approvedHashMatches =
    cap.status === "approved"
      ? cap.review?.approvedHash
        ? cap.review.approvedHash === hash
        : false
      : null;
  let effectiveStatus = cap.status;
  if (cap.status === "approved" && !approvedHashMatches) {
    problems.push(
      cap.review?.approvedHash
        ? "content changed since approval; treated as draft"
        : "approved without an approval hash; treated as draft",
    );
    effectiveStatus = "draft";
  }
  return { hash, storedHashMatches, approvedHashMatches, effectiveStatus, problems };
}

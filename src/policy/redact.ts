/**
 * Redaction is applied at every sink (events, transcripts, artifacts, result files).
 * Three sources of sensitivity:
 *   1. registered secret values (credentials resolved from the secret store),
 *   2. registered sensitive values (inputs/outputs whose spec says pii/financial),
 *   3. built-in patterns for regulated data that may appear on screen (SSN, card PAN).
 */
const BUILTIN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "card", re: /\b(?:\d[ -]?){13,16}\b/g },
  { label: "email", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g },
];

export class Redactor {
  private secrets: string[] = [];
  private sensitive = new Map<string, string>();
  private extra: Array<{ label: string; re: RegExp }> = [];

  constructor(extraPatterns: Array<{ label: string; pattern: string }> = []) {
    for (const p of extraPatterns)
      this.extra.push({ label: p.label, re: new RegExp(p.pattern, "g") });
  }

  registerSecret(value: string): void {
    if (value.length >= 3 && !this.secrets.includes(value)) {
      this.secrets.push(value);
      this.secrets.sort((a, b) => b.length - a.length);
    }
  }

  /** Mask a value everywhere it appears, keeping enough shape to debug ("1***3"). */
  registerSensitive(value: string, label: string): void {
    if (value.length < 3) return;
    const shaped = value.length >= 4 ? `${value[0]}***${value[value.length - 1]}` : "***";
    this.sensitive.set(value, `[${label}:${shaped}]`);
  }

  redactString(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join("[REDACTED:secret]");
    const sens = [...this.sensitive.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [value, mask] of sens) out = out.split(value).join(mask);
    for (const { label, re } of [...BUILTIN_PATTERNS, ...this.extra]) {
      out = out.replace(re, `[REDACTED:${label}]`);
    }
    return out;
  }

  /** Deep-redact any JSON-like value. Buffers and functions are dropped. */
  redact<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(v: unknown, depth: number): unknown {
    if (depth > 32) return "[depth-limit]";
    if (typeof v === "string") return this.redactString(v);
    if (v === null || typeof v !== "object") return v;
    if (Buffer.isBuffer(v)) return `[buffer:${v.length}]`;
    if (Array.isArray(v)) return v.map((x) => this.walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "function") continue;
      out[k] = /password|passwd|secret|token|authorization|cookie/i.test(k)
        ? "[REDACTED:key]"
        : this.walk(val, depth + 1);
    }
    return out;
  }

  /** Assert that no registered secret leaked into a serialised document. */
  assertClean(serialised: string, what: string, opts: { sensitive?: boolean } = {}): void {
    for (const secret of this.secrets) {
      if (serialised.includes(secret)) {
        throw new Error(`Refusing to persist ${what}: contains a secret value`);
      }
    }
    if (opts.sensitive) {
      for (const value of this.sensitive.keys()) {
        if (serialised.includes(value))
          throw new Error(`Refusing to persist ${what}: contains a sensitive (PII) value`);
      }
    }
  }
}

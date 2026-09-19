/** Template / parameter interpolation shared by recorder and replay. */
import type { ValueRef } from "./schema.js";

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export type Params = Record<string, string>;

export class MissingParamError extends Error {
  constructor(public readonly paramName: string) {
    super(`Missing parameter "${paramName}"`);
    this.name = "MissingParamError";
  }
}

export function hasPlaceholders(s: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(s);
}

export function placeholderNames(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(PLACEHOLDER)) out.push(m[1]!);
  return out;
}

/** Interpolate `{{name}}` placeholders with params; throws when a param is missing. */
export function interpolate(template: string, params: Params): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new MissingParamError(name);
    return v;
  });
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * URL/title patterns are stored as *templates that are also regexes*: literal text between
 * placeholders is regex; placeholder values are regex-escaped on interpolation.
 */
export function templateToRegex(pattern: string, params: Params): RegExp {
  const src = pattern.replace(PLACEHOLDER, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new MissingParamError(name);
    return escapeRegex(v);
  });
  return new RegExp(src);
}

/**
 * Replace occurrences of known param values inside a recorded literal with placeholders,
 * longest values first, so a discovery-time literal "10023" becomes "{{member_id}}".
 * Values shorter than 3 chars are never parameterised (too ambiguous).
 */
export function parameterize(literal: string, params: Params): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  let out = literal;
  for (const [name, value] of entries) {
    if (out.includes(value)) out = out.split(value).join(`{{${name}}}`);
  }
  return out;
}

export interface SecretResolver {
  resolve(ref: string): string;
}

/** Materialise a ValueRef at runtime. Secrets are resolved but never returned to logs. */
export function resolveValue(
  ref: ValueRef,
  params: Params,
  secrets: SecretResolver,
): { value: string; sensitive: boolean } {
  switch (ref.kind) {
    case "literal":
      return { value: ref.value, sensitive: false };
    case "param": {
      const v = params[ref.name];
      if (v === undefined) throw new MissingParamError(ref.name);
      return { value: v, sensitive: false };
    }
    case "template":
      return { value: interpolate(ref.template, params), sensitive: false };
    case "secret":
      return { value: secrets.resolve(ref.ref), sensitive: true };
  }
}

/** Human-readable rendering of a ValueRef for logs — never reveals secrets. */
export function describeValue(ref: ValueRef): string {
  switch (ref.kind) {
    case "literal":
      return JSON.stringify(ref.value);
    case "param":
      return `{{${ref.name}}}`;
    case "template":
      return ref.template;
    case "secret":
      return `<secret:${ref.ref}>`;
  }
}

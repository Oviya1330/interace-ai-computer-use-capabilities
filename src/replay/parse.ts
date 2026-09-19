import type { Parser } from "../core/schema.js";
import { RunFailure } from "../core/errors.js";

export type ParsedValue = string | number | boolean | null;

export function parseValue(raw: string, parser: Parser): ParsedValue {
  const text = raw.replace(/\s+/g, " ").trim();
  switch (parser.type) {
    case "text":
      return text;
    case "number": {
      const n = Number(text.replace(/,/g, ""));
      if (Number.isNaN(n)) throw new RunFailure("OUTPUT_PARSE_ERROR", `"${text}" is not a number`);
      return n;
    }
    case "currency": {
      const negative = /^\(.*\)$/.test(text) || text.includes("-");
      const digits = text.replace(/[^0-9.]/g, "");
      if (!digits) throw new RunFailure("OUTPUT_PARSE_ERROR", `"${text}" is not a currency amount`);
      const n = Number(digits);
      if (Number.isNaN(n))
        throw new RunFailure("OUTPUT_PARSE_ERROR", `"${text}" is not a currency amount`);
      return negative ? -n : n;
    }
    case "boolean": {
      const truthy = (parser.truthy ?? ["yes", "true", "y", "active", "checked", "on"]).map((s) =>
        s.toLowerCase(),
      );
      return truthy.includes(text.toLowerCase());
    }
    case "regex": {
      const m = new RegExp(parser.pattern).exec(text);
      if (!m)
        throw new RunFailure("OUTPUT_PARSE_ERROR", `"${text}" does not match /${parser.pattern}/`);
      return m[parser.group ?? 1] ?? m[0] ?? null;
    }
  }
}

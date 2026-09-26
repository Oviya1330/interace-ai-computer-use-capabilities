/**
 * Code generation (stretch goal): emit a standalone, runnable Playwright script from an
 * artifact. The script uses Playwright-native locators for the primary strategies and a small
 * inline helper for the legacy-specific ones (label cell, table relation), asserts the recorded
 * pre/post-conditions and checkpoint, and prints the extracted outputs as JSON.
 */
import type {
  AppProfile,
  Capability,
  Expectation,
  Step,
  Target,
  TargetStrategy,
  TenantBinding,
  ValueRef,
} from "../core/schema.js";
import { escapeRegex, interpolate, type Params } from "../core/template.js";

const q = (s: string): string => JSON.stringify(s);
const xq = (s: string): string =>
  s.includes("'") ? `concat('${s.split("'").join(`',"'",'`)}')` : `'${s}'`;

interface GenContext {
  params: Params;
  /** Capability inputs, read from the script's `inputs` object at run time. */
  inputs: Record<string, string>;
  tenant: TenantBinding;
  contentFrame: string[];
}

/** A ValueRef as a JS expression: inputs are looked up, tenant params baked in, secrets read from env. */
function valueExpr(v: ValueRef, ctx: GenContext): string {
  switch (v.kind) {
    case "param":
      return v.name in ctx.inputs ? `inputs[${q(v.name)}]` : q(ctx.params[v.name] ?? "");
    case "literal":
      return q(v.value);
    case "template":
      return q(interpolate(v.template, ctx.params));
    case "secret": {
      const src = ctx.tenant.secrets[v.ref] ?? "";
      const envVar = src.startsWith("env:") ? src.slice(4) : v.ref.toUpperCase();
      return `(process.env[${q(envVar)}] ?? "")`;
    }
  }
}

function frameExpr(frame: string[]): string {
  return frame.length ? `page${frame.map((f) => `.frame(${q(f)})`).join("")}` : "page.mainFrame()";
}

function strategyToLocator(s: TargetStrategy, params: Params): string | null {
  const i = (t: string) => interpolate(t, params);
  switch (s.kind) {
    case "role":
      return `getByRole(${q(s.role)}, { name: ${q(i(s.name ?? ""))}, exact: true })`;
    case "text":
      return `locator(${q(s.tag ?? "*")}, { hasText: ${q(i(s.text))} })`;
    case "attr": {
      const sel =
        (s.tag ?? "") +
        Object.entries(s.attrs)
          .map(([k, v]) => `[${k}="${i(v).replace(/"/g, '\\"')}"]`)
          .join("");
      return `locator(${q(sel)})`;
    }
    case "label": {
      const xp =
        s.control === "value"
          ? `//td[normalize-space()=${xq(i(s.text))}]/following-sibling::td[normalize-space()!=''][1]`
          : `//td[normalize-space()=${xq(i(s.text))}]/following-sibling::td[1]//*[self::input or self::select or self::textarea]`;
      return `locator(${q("xpath=" + xp)})`;
    }
    case "table": {
      const col = (h: string) =>
        `count(../../tr[1]/*[normalize-space()=${xq(i(h))}]/preceding-sibling::*)+1`;
      const rowPred = s.row
        ? `[td[${col(s.row.column)}][normalize-space()=${xq(i(s.row.equals))}]]`
        : `[${(s.rowIndex ?? 0) + 2}]`;
      const inner =
        s.inner === "link"
          ? "//a"
          : s.inner === "control"
            ? "//*[self::input or self::select or self::button]"
            : "";
      return `locator(${q("xpath=" + `//table//tr${rowPred}/td[${col(s.column)}]${inner}`)})`;
    }
    case "css":
      return `locator(${q(s.selector)})`;
    case "xpath":
      return `locator(${q("xpath=" + s.expression)})`;
    case "visual":
      return null;
  }
}

function targetCode(t: Target, params: Params): string {
  const locs = t.strategies
    .map((s) => strategyToLocator(s, params))
    .filter((x): x is string => !!x);
  return `await first(${frameExpr(t.frame)}, [\n${locs.map((l) => `      (f) => f.${l},`).join("\n")}\n    ], ${q(t.description)})`;
}

function expectCode(e: Expectation, params: Params, contentFrame: string[]): string[] {
  switch (e.kind) {
    case "url":
      return [
        `await waitFor(() => new RegExp(${q(urlPatternSource(e.pattern, params))}).test(${frameExpr(e.frame ?? contentFrame)}.url()), ${q(`url matches ${e.pattern}`)});`,
      ];
    case "text":
      return [
        `await waitFor(async () => (await ${frameExpr(e.frame ?? contentFrame)}.evaluate(() => document.body?.innerText ?? "")).includes(${q(interpolate(e.text, params))}) === ${e.present !== false}, ${q(`text "${e.text}" ${e.present === false ? "absent" : "present"}`)});`,
      ];
    case "all":
      return e.of.flatMap((x) => expectCode(x, params, contentFrame));
    case "any":
      return [
        `// any-of expectation (${e.of.length} alternatives) — checked at replay, simplified here`,
      ];
    default:
      return [`// ${e.kind} expectation not generated`];
  }
}

function stepCode(step: Step, ctx: GenContext): string {
  const { params, contentFrame } = ctx;
  const lines: string[] = [
    `  // ${step.name}${step.intent ? ` — ${step.intent}` : ""}${step.risk !== "safe" ? ` [${step.risk.toUpperCase()}]` : ""}`,
  ];
  for (const pre of step.precondition)
    lines.push(...expectCode(pre, params, contentFrame).map((l) => `  ${l}`));
  switch (step.kind) {
    case "navigate":
      lines.push(`  await page.goto(${valueExpr(step.url, ctx)});`);
      break;
    case "click":
      if (step.dialog) lines.push(`  page.once("dialog", (d) => d.${step.dialog.response}());`);
      lines.push(`  await (${targetCode(step.target, params)}).click();`);
      break;
    case "type":
      lines.push(
        `  await (${targetCode(step.target, params)}).fill(${valueExpr(step.value, ctx)});`,
      );
      if (step.pressEnter) lines.push(`  await page.keyboard.press("Enter");`);
      break;
    case "select":
      lines.push(
        `  await (${targetCode(step.target, params)}).selectOption({ label: ${valueExpr(step.value, ctx)} });`,
      );
      break;
    case "press":
      lines.push(`  await page.keyboard.press(${q(step.key)});`);
      break;
    case "extract":
      lines.push(
        `  outputs[${q(step.output)}] = parse(${q(step.parse.type)}, await (${targetCode(step.target, params)}).innerText());`,
      );
      break;
    case "wait":
      lines.push(`  await page.waitForTimeout(${step.ms ?? 1000});`);
      break;
    case "assert":
      break;
  }
  lines.push(`  await settle(page);`);
  for (const e of step.expect)
    lines.push(...expectCode(e, params, contentFrame).map((l) => `  ${l}`));
  return lines.join("\n");
}

/** A url expectation's regex source: tenant params escaped now, input values escaped at run time. */
function urlPatternSource(pattern: string, params: Params): string {
  return pattern.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    const v = params[name] ?? "";
    return v === `{{${name}}}` ? `{{re:${name}}}` : escapeRegex(v);
  });
}

/** Turn input placeholders inside generated string literals into runtime lookups. */
function spliceInputs(script: string, names: string[]): string {
  return script
    .split("\n")
    .map((line) => {
      // Comments keep the readable placeholder; only code gets the runtime lookup.
      if (/^\s*(\/\/|\*)/.test(line)) return line.replace(/\{\{re:/g, "{{");
      let out = line;
      for (const n of names) {
        out = out.split(`{{re:${n}}}`).join(`" + reEscape(inputs[${q(n)}]!) + "`);
        out = out.split(`{{${n}}}`).join(`" + inputs[${q(n)}] + "`);
      }
      return out;
    })
    .join("\n");
}

export function generatePlaywrightScript(
  cap: Capability,
  profile: AppProfile,
  tenant: TenantBinding,
  inputs: Record<string, string>,
): string {
  // Input values are never baked into the script: generate with placeholders, then splice
  // runtime lookups into the string literals (inputs arrive as a JSON argument).
  const placeholders = Object.fromEntries(Object.keys(inputs).map((k) => [k, `{{${k}}}`]));
  const params: Params = { ...tenant.params, ...placeholders };
  const ctx: GenContext = { params, inputs, tenant, contentFrame: profile.contentFrame };
  const login = profile.session.login.steps.map((s) => stepCode(s, ctx)).join("\n");
  const body = cap.steps.map((s) => stepCode(s, ctx)).join("\n\n");
  const checkpoint = cap.checkpoint.expect
    .flatMap((e) => expectCode(e, params, profile.contentFrame))
    .map((l) => `  ${l}`)
    .join("\n");
  const entry = valueExpr(profile.session.login.entry, ctx);
  const script = `/**
 * Generated by \`cua codegen\` from ${cap.name}@${cap.version} (${cap.title}).
 * Standalone Playwright automation: primary locator strategies with fallbacks, recorded
 * pre/post-conditions and the checkpoint. Run: npx tsx <this file>
 * Inputs (JSON argument): ${Object.keys(inputs).join(", ") || "none"}  Tenant: ${tenant.id}
 * Example: npx tsx <this file> '${JSON.stringify(Object.fromEntries(Object.keys(inputs).map((k) => [k, "..."])))}'
 */
import { chromium, type Frame, type Locator, type Page } from "playwright";

const inputs: Record<string, string> = JSON.parse(process.argv[2] ?? "{}");
for (const name of ${JSON.stringify(Object.keys(inputs))})
  if (typeof inputs[name] !== "string") throw new Error(\`missing input "\${name}" (pass inputs as a JSON argument)\`);
const reEscape = (s: string): string => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
const outputs: Record<string, unknown> = {};

async function first(frame: Frame | null, candidates: Array<(f: Frame) => Locator>, what: string): Promise<Locator> {
  if (!frame) throw new Error(\`frame not found for \${what}\`);
  const deadline = Date.now() + ${profile.defaultStepTimeoutMs};
  while (Date.now() < deadline) {
    for (const c of candidates) {
      const loc = c(frame);
      const n = await loc.count().catch(() => 0);
      if (n === 1 && (await loc.first().isVisible().catch(() => false))) return loc.first();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(\`could not resolve \${what}\`);
}
async function waitFor(cond: () => Promise<boolean> | boolean, what: string, ms = ${profile.defaultStepTimeoutMs}): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(\`expectation failed: \${what}\`);
}
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(${profile.settle.domQuietMs});
}
function parse(kind: string, raw: string): unknown {
  const t = raw.trim();
  if (kind === "currency") return Number(t.replace(/[^0-9.-]/g, "")) * (/^\\(.*\\)$/.test(t) ? -1 : 1);
  if (kind === "number") return Number(t.replace(/,/g, ""));
  return t;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
  const page = await browser.newPage({ viewport: { width: ${profile.viewport.width}, height: ${profile.viewport.height} } });
  try {
    // --- session bootstrap (from app profile ${profile.id}; the password comes from the environment)
    await page.goto(${entry});
    await settle(page);
${login}

    // --- capability steps
${body}

    // --- checkpoint: ${cap.checkpoint.description}
${checkpoint}
    console.log(JSON.stringify({ status: "success", outputs }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ status: "failure", error: e instanceof Error ? e.message : String(e) }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
`;
  return spliceInputs(script, Object.keys(inputs));
}

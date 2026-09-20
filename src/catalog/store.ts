/**
 * File-backed catalog: capabilities, app profiles, tenant bindings, policy.
 * Layout (relative to the project root / CUA_HOME):
 *   capabilities/<name>@<version>.json
 *   profiles/<id>.json
 *   tenants/<id>.json
 *   policy.yaml
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  AppProfile,
  Capability,
  TenantBinding,
  type Capability as CapabilityT,
} from "../core/schema.js";
import { PolicyConfig } from "../policy/policy.js";
import type { Redactor } from "../policy/redact.js";
import { withIntegrity } from "./integrity.js";

export function projectRoot(): string {
  return process.env.CUA_HOME ?? process.cwd();
}

/** Minimal .env loader (no dependency): KEY=VALUE lines, does not override existing env. */
export function loadDotEnv(file = path.join(projectRoot(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (v !== "" && process.env[m[1]!] === undefined) process.env[m[1]!] = v;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface CapabilitySummary {
  name: string;
  version: string;
  status: CapabilityT["status"];
  title: string;
  file: string;
  inputs: string[];
  outputs: string[];
  riskClass: string;
}

export class CapabilityStore {
  readonly dir: string;
  constructor(root: string = projectRoot()) {
    this.dir = path.join(root, "capabilities");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(name: string, version: string): string {
    return path.join(this.dir, `${name}@${version}.json`);
  }

  list(): CapabilitySummary[] {
    const out: CapabilitySummary[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const cap = Capability.parse(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")));
        out.push({
          name: cap.name,
          version: cap.version,
          status: cap.status,
          title: cap.title,
          file: path.join(this.dir, f),
          inputs: Object.keys(cap.inputs),
          outputs: Object.keys(cap.outputs),
          riskClass: cap.policy.riskClass,
        });
      } catch {
        /* skip invalid files; `cua validate` reports them */
      }
    }
    return out.sort(
      (a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version),
    );
  }

  /** Load by name (latest version), name@version, or a file path. */
  load(ref: string): CapabilityT {
    if (ref.endsWith(".json") && fs.existsSync(ref)) {
      return Capability.parse(JSON.parse(fs.readFileSync(ref, "utf8")));
    }
    const [name, version] = ref.split("@");
    const candidates = this.list().filter(
      (c) => c.name === name && (!version || c.version === version),
    );
    if (candidates.length === 0) throw new Error(`Capability "${ref}" not found in ${this.dir}`);
    const best = candidates.sort((a, b) => compareVersions(b.version, a.version))[0]!;
    return Capability.parse(JSON.parse(fs.readFileSync(best.file, "utf8")));
  }

  /** Validate, prove no secret leaked, then write. Returns the file path. */
  save(cap: CapabilityT, redactor: Redactor): string {
    const parsed = withIntegrity(Capability.parse(cap));
    const text = JSON.stringify(parsed, null, 2) + "\n";
    redactor.assertClean(text, `capability ${parsed.name}@${parsed.version}`, { sensitive: true });
    const file = this.fileFor(parsed.name, parsed.version);
    fs.writeFileSync(file, text);
    return file;
  }

  nextVersion(name: string): string {
    const existing = this.list().filter((c) => c.name === name);
    if (existing.length === 0) return "1.0.0";
    const latest = existing.sort((a, b) => compareVersions(b.version, a.version))[0]!.version;
    const [maj, min] = latest.split(".").map(Number);
    return `${maj}.${(min ?? 0) + 1}.0`;
  }
}

export function loadProfile(id: string, root: string = projectRoot()): AppProfile {
  const file = path.join(root, "profiles", `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`App profile "${id}" not found (${file})`);
  return AppProfile.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function loadTenant(id: string, root: string = projectRoot()): TenantBinding {
  const file = path.join(root, "tenants", `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Tenant "${id}" not found (${file})`);
  return withDerivedParams(TenantBinding.parse(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/** base_url and base_path are always available to templates, derived from the binding. */
function withDerivedParams(t: TenantBinding): TenantBinding {
  const params = { ...t.params };
  if (!params.base_url) params.base_url = t.baseUrl;
  if (!params.base_path) params.base_path = new URL(t.baseUrl).pathname.replace(/\/$/, "");
  return { ...t, params };
}

export function listTenants(root: string = projectRoot()): TenantBinding[] {
  const dir = path.join(root, "tenants");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) =>
      withDerivedParams(
        TenantBinding.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))),
      ),
    );
}

export function loadPolicy(file: string = path.join(projectRoot(), "policy.yaml")): PolicyConfig {
  if (!fs.existsSync(file)) throw new Error(`Policy file not found: ${file}`);
  return PolicyConfig.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}

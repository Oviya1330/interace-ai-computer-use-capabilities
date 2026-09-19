/**
 * Wires the pieces for one process: policy, redaction, secrets, the browser surface, the
 * intervention broker, the operator console and the live-session controller.
 */
import path from "node:path";
import { PolicyGate, type PolicyConfig } from "./policy/policy.js";
import { Redactor } from "./policy/redact.js";
import { EnvSecretStore } from "./policy/secrets.js";
import { PlaywrightSurface } from "./surface/playwright.js";
import { InterventionBroker } from "./hitl/broker.js";
import { startOperatorConsole, type OperatorConsole } from "./hitl/console.js";
import { LiveSessionController } from "./hitl/session.js";
import { RunEvidence } from "./evidence/store.js";
import {
  CapabilityStore,
  loadDotEnv,
  loadPolicy,
  loadProfile,
  loadTenant,
  projectRoot,
} from "./catalog/store.js";
import type { AppProfile, TenantBinding } from "./core/schema.js";

export interface RuntimeOptions {
  tenantId: string;
  headless?: boolean;
  policyFile?: string;
  policy?: PolicyConfig;
  /** Start the operator console (default true). Without it, hard failures fail instead of escalating. */
  console?: boolean;
  consolePort?: number;
  evidenceRoot?: string;
  tracing?: boolean;
  slowMo?: number;
  root?: string;
  /** Do not launch a browser (catalog-only commands). */
  noBrowser?: boolean;
}

export interface Runtime {
  root: string;
  policy: PolicyGate;
  redactor: Redactor;
  profile: AppProfile;
  tenant: TenantBinding;
  secrets: EnvSecretStore;
  surface: PlaywrightSurface;
  broker: InterventionBroker | null;
  console: OperatorConsole | null;
  session: LiveSessionController | null;
  store: CapabilityStore;
  evidenceRoot: string;
  newEvidence(runId: string, label?: string): RunEvidence;
  close(): Promise<void>;
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const root = o.root ?? projectRoot();
  loadDotEnv(path.join(root, ".env"));
  const policyConfig = o.policy ?? loadPolicy(o.policyFile ?? path.join(root, "policy.yaml"));
  const policy = new PolicyGate(policyConfig);
  const redactor = new Redactor(policyConfig.data.redactPatterns);
  const tenant = loadTenant(o.tenantId, root);
  const profile = loadProfile(tenant.profile, root);
  const secrets = new EnvSecretStore(tenant.secrets, redactor);
  const store = new CapabilityStore(root);
  const evidenceRoot = path.resolve(root, o.evidenceRoot ?? "runs");

  let surface: PlaywrightSurface | null = null;
  if (!o.noBrowser) {
    surface = await PlaywrightSurface.launch({
      headless: o.headless ?? true,
      viewport: profile.viewport,
      contentFrame: profile.contentFrame,
      settle: profile.settle,
      screenshots: policyConfig.data.screenshots,
      tracing: o.tracing ?? true,
      slowMo: o.slowMo,
      kind: profile.surface === "desktop" ? "web" : profile.surface,
    });
  }

  let broker: InterventionBroker | null = null;
  let console_: OperatorConsole | null = null;
  let session: LiveSessionController | null = null;
  if (o.console !== false && surface) {
    broker = new InterventionBroker();
    session = new LiveSessionController(surface, broker, null, tenant.params);
    const sessionRef = session;
    const port = o.consolePort ?? policyConfig.escalation.console.port;
    try {
      console_ = await startOperatorConsole({
        port,
        broker,
        session: () => sessionRef,
        evidenceRoot: () => evidenceRoot,
      });
    } catch {
      console_ = await startOperatorConsole({
        port: 0,
        broker,
        session: () => sessionRef,
        evidenceRoot: () => evidenceRoot,
      });
      process.stderr.write(`[cua] port ${port} busy; operator console on ${console_.url}\n`);
    }
  }

  return {
    root,
    policy,
    redactor,
    profile,
    tenant,
    secrets,
    surface: surface as PlaywrightSurface,
    broker,
    console: console_,
    session,
    store,
    evidenceRoot,
    newEvidence: (runId, label) => new RunEvidence(evidenceRoot, runId, redactor, label),
    close: async () => {
      await session?.stopScreencast().catch(() => {});
      await console_?.close().catch(() => {});
      await surface?.close().catch(() => {});
    },
  };
}

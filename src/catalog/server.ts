/**
 * Agent-facing capability API (stretch goal): the catalog as a callable surface.
 *   GET  /capabilities                 -> catalog + tool definitions (function-calling shape)
 *   GET  /capabilities/:name           -> reviewer view of the artifact
 *   POST /capabilities/:name/invoke    -> { tenant, inputs, approval? } -> RunResult
 * One browser session per tenant, invocations serialised per tenant; the operator console
 * is shared so replays can still escalate to a human.
 */
import express from "express";
import http from "node:http";
import { CapabilityStore } from "./store.js";
import { capabilityToTool } from "./tools.js";
import { createRuntime, type Runtime } from "../runtime.js";
import { replayCommand } from "../cli/commands.js";
import { errorMessage } from "../core/errors.js";

export interface CapabilityServer {
  url: string;
  close(): Promise<void>;
}

export async function startCapabilityServer(o: {
  port: number;
  headless?: boolean;
  evidenceRoot?: string;
  consolePort?: number;
}): Promise<CapabilityServer> {
  const store = new CapabilityStore();
  const runtimes = new Map<string, Promise<Runtime>>();
  const queues = new Map<string, Promise<unknown>>();
  const runtimeFor = (tenant: string): Promise<Runtime> => {
    if (!runtimes.has(tenant)) {
      runtimes.set(
        tenant,
        createRuntime({
          tenantId: tenant,
          headless: o.headless ?? true,
          evidenceRoot: o.evidenceRoot,
          consolePort: o.consolePort,
          console: runtimes.size === 0,
        }),
      );
    }
    return runtimes.get(tenant)!;
  };
  const serialised = <T>(tenant: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(tenant) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(tenant, next);
    return next;
  };

  const app = express();
  app.use(express.json());
  const strip = (v: unknown) =>
    JSON.parse(
      JSON.stringify(v, (k, x) =>
        k === "template" && typeof x === "string" && x.length > 64 ? `[png ${x.length}b]` : x,
      ),
    );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, tenants: [...runtimes.keys()] });
  });
  app.get("/capabilities", (_req, res) => {
    const list = store.list();
    res.json({
      capabilities: list,
      tools: list.map((c) => capabilityToTool(store.load(`${c.name}@${c.version}`))),
    });
  });
  app.get("/capabilities/:name", (req, res) => {
    try {
      res.json(strip(store.load(req.params.name)));
    } catch (e) {
      res.status(404).json({ error: errorMessage(e) });
    }
  });
  app.post("/capabilities/:name/invoke", async (req, res) => {
    const tenant = String(req.body?.tenant ?? "summit");
    const inputs = (req.body?.inputs ?? {}) as Record<string, unknown>;
    const approval = req.body?.approval as { by: string; reason: string } | undefined;
    const requestedBy = req.body?.requestedBy ? String(req.body.requestedBy) : undefined;
    const idempotencyKey = req.body?.idempotencyKey
      ? String(req.body.idempotencyKey)
      : (req.headers["idempotency-key"] as string | undefined);
    try {
      const result = await serialised(tenant, async () => {
        const rt = await runtimeFor(tenant);
        const [r] = await replayCommand({
          capability: req.params.name,
          tenant,
          inputs,
          approve: approval?.reason,
          approvedBy: approval?.by,
          requestedBy,
          idempotencyKey,
          runtime: rt,
          evidenceRoot: o.evidenceRoot,
          log: () => {},
        });
        return r!;
      });
      res.status(result.status === "failure" ? 500 : 200).json(result);
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      for (const rt of runtimes.values()) await (await rt).close().catch(() => {});
    },
  };
}

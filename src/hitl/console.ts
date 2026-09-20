/**
 * Minimal operator console: an HTTP + WebSocket server that lists intervention requests with
 * their context, lets an operator take control of the live session (screencast + input
 * forwarding), and hand control back with a resolution. The UI is deliberately bare; the
 * control-transfer mechanism underneath is real.
 */
import fs from "node:fs";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { InterventionBroker } from "./broker.js";
import type { LiveSessionController } from "./session.js";
import { errorMessage } from "../core/errors.js";

export interface ConsoleOptions {
  port: number;
  broker: InterventionBroker;
  /** The live session of the current run (null when no run is active). */
  session: () => LiveSessionController | null;
  /** Serve evidence files for screenshots. */
  evidenceRoot?: () => string | null;
  /** Bearer token operators must present (also accepted as ?token=). Empty = open. */
  token?: string;
}

export interface OperatorConsole {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startOperatorConsole(o: ConsoleOptions): Promise<OperatorConsole> {
  const app = express();
  app.use(express.json());
  const html = fs.readFileSync(new URL("./console.html", import.meta.url), "utf8");
  const token = o.token ?? "";
  const presented = (req: {
    headers: Record<string, unknown>;
    query: Record<string, unknown>;
  }): string =>
    String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") ||
    String(req.query.token ?? "");
  app.use("/api", (req, res, next) => {
    if (token && presented(req as never) !== token)
      return res.status(401).json({ error: "operator token required" });
    next();
  });

  app.get("/", (_req, res) => {
    res.type("html").send(html);
  });
  app.get("/api/state", (_req, res) => {
    res.json({
      controlOwner: o.broker.controlOwner(),
      active: o.broker.activeControlled()?.id ?? null,
      streaming: o.session()?.streaming ?? false,
    });
  });
  app.get("/api/interventions", (_req, res) => {
    res.json(o.broker.list());
  });
  app.get("/api/interventions/:id", (req, res) => {
    const r = o.broker.get(req.params.id);
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  });
  app.get("/api/interventions/:id/screenshot.png", (req, res) => {
    const png = o.broker.screenshotOf(req.params.id);
    if (png) return res.type("png").send(png);
    const r = o.broker.get(req.params.id);
    const root = o.evidenceRoot?.();
    if (r?.screenshot && root && fs.existsSync(`${root}/${r.screenshot}`))
      return res.type("png").sendFile(`${root}/${r.screenshot}`);
    res.status(404).end();
  });
  app.post("/api/interventions/:id/take-control", async (req, res) => {
    try {
      const operator = String(req.body?.operator ?? "operator");
      const r = o.broker.takeControl(req.params.id, operator);
      await o.session()?.startScreencast();
      res.json(r);
    } catch (e) {
      res.status(409).json({ error: errorMessage(e) });
    }
  });
  app.post("/api/interventions/:id/resolve", async (req, res) => {
    try {
      const kind = req.body?.kind;
      const wasHuman = o.broker.get(req.params.id)?.control.owner === "human";
      if (wasHuman) await o.session()?.stopScreencast();
      const r = o.broker.resolve(req.params.id, {
        kind,
        note: req.body?.note,
        operator: req.body?.operator ?? "operator",
      });
      res.json(r);
    } catch (e) {
      res.status(409).json({ error: errorMessage(e) });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();
    if (token && url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
  };
  o.broker.on("update", () =>
    broadcast({
      type: "interventions",
      list: o.broker.list(),
      controlOwner: o.broker.controlOwner(),
    }),
  );

  let unsubscribeFrames: (() => void) | null = null;
  const attachFrames = () => {
    const s = o.session();
    if (!s || unsubscribeFrames) return;
    unsubscribeFrames = s.onFrame((f) =>
      broadcast({ type: "frame", data: f.data, width: f.width, height: f.height }),
    );
  };
  o.broker.on("control", () => {
    attachFrames();
  });

  wss.on("connection", (ws) => {
    attachFrames();
    ws.send(
      JSON.stringify({
        type: "interventions",
        list: o.broker.list(),
        controlOwner: o.broker.controlOwner(),
      }),
    );
    const last = o.session()?.latestFrame();
    if (last)
      ws.send(
        JSON.stringify({ type: "frame", data: last.data, width: last.width, height: last.height }),
      );
    ws.on("message", async (raw) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const s = o.session();
      try {
        if (!s) throw new Error("no live session");
        if (msg.type === "mouse") {
          await s.mouse({
            type: msg.event as "mousePressed",
            x: Number(msg.x),
            y: Number(msg.y),
            button: msg.button as "left",
            clickCount: msg.clickCount as number,
          });
        } else if (msg.type === "key") {
          await s.key({
            type: msg.event as "keyDown",
            key: String(msg.key),
            code: msg.code as string,
            text: msg.text as string,
          });
        } else if (msg.type === "text") {
          await s.insertText(String(msg.text));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: errorMessage(e) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

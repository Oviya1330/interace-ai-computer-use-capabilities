/**
 * A scripted "human operator" for demos and tests. It talks to the operator console exactly
 * the way a person's browser would: REST to take control / hand back, WebSocket to send
 * mouse input into the live session. Used to demonstrate the handoff without a person.
 *
 *   tsx scripts/operator-bot.ts --console http://127.0.0.1:4790 --click "I Acknowledge" --resolve retry
 *   tsx scripts/operator-bot.ts --console http://127.0.0.1:4790 --resolve approve
 */
import WebSocket from "ws";

interface Intervention {
  id: string;
  type: string;
  status: string;
  allowedResolutions: string[];
  elements: Array<{
    ref: string;
    role: string;
    name: string;
    text: string;
    bbox: { x: number; y: number; w: number; h: number };
  }>;
  reason: { code: string; message: string };
}

const args = process.argv.slice(2);
const opt = (name: string, def?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const consoleUrl = opt("console", "http://127.0.0.1:4790")!;
const clickName = opt("click");
const resolveKind = opt("resolve", clickName ? "retry" : "approve")!;
const timeoutMs = Number(opt("timeout", "120000"));
const operator = opt("operator", "operator-bot")!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForIntervention(): Promise<Intervention> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const list = (await fetch(`${consoleUrl}/api/interventions`)
      .then((r) => r.json())
      .catch(() => [])) as Intervention[];
    const open = list.find((i) => i.status === "open");
    if (open) return open;
    await sleep(500);
  }
  throw new Error("operator-bot: no intervention appeared in time");
}

async function main(): Promise<void> {
  const it = await waitForIntervention();
  process.stderr.write(
    `[operator-bot] intervention ${it.id} (${it.type}): ${it.reason.code} - ${it.reason.message}\n`,
  );

  if (clickName) {
    const re = new RegExp(clickName, "i");
    const target = it.elements.find((e) => re.test(e.name) || re.test(e.text));
    if (!target)
      throw new Error(
        `operator-bot: no element matching /${clickName}/ among ${it.elements.map((e) => e.name || e.text).join(", ")}`,
      );
    const res = await fetch(`${consoleUrl}/api/interventions/${it.id}/take-control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operator }),
    });
    if (!res.ok) throw new Error(`take-control failed: ${await res.text()}`);
    process.stderr.write(`[operator-bot] took control of the live session\n`);
    const ws = new WebSocket(`${consoleUrl.replace(/^http/, "ws")}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    let frames = 0;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "frame") frames++;
      if (m.type === "error") process.stderr.write(`[operator-bot] console error: ${m.message}\n`);
    });
    await sleep(800);
    const x = target.bbox.x + target.bbox.w / 2;
    const y = target.bbox.y + target.bbox.h / 2;
    process.stderr.write(
      `[operator-bot] clicking ${target.role} "${target.name || target.text}" at ${Math.round(x)},${Math.round(y)} through the live session\n`,
    );
    ws.send(JSON.stringify({ type: "mouse", event: "mouseMoved", x, y, button: "none" }));
    await sleep(100);
    ws.send(
      JSON.stringify({ type: "mouse", event: "mousePressed", x, y, button: "left", clickCount: 1 }),
    );
    await sleep(80);
    ws.send(
      JSON.stringify({
        type: "mouse",
        event: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      }),
    );
    await sleep(1500);
    process.stderr.write(`[operator-bot] received ${frames} screencast frames\n`);
    ws.close();
  }

  const res = await fetch(`${consoleUrl}/api/interventions/${it.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: resolveKind,
      operator,
      note: clickName
        ? `Acknowledged "${clickName}" manually, handing back with ${resolveKind}`
        : `Resolved with ${resolveKind}`,
    }),
  });
  if (!res.ok) throw new Error(`resolve failed: ${await res.text()}`);
  process.stderr.write(`[operator-bot] handed control back: ${resolveKind}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

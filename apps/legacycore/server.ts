/**
 * LegacyCore Teller Console - a mock legacy core-banking back-office app.
 *
 * Server-rendered, frameset-based, table-layout HTML with no ids/test-ids/labels/ARIA.
 * Two tenants (/t/summit, /t/cascade) run the "same vendor product" with different
 * branding, field names, button labels and column order. Test-only chaos hooks under
 * /__chaos inject the runtime conditions a replay must survive (slow responses, app
 * errors, session expiry, known and unknown interstitials).
 *
 *   PORT=4173 npx tsx apps/legacycore/server.ts
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChaosController, ChaosError } from "./chaos.js";
import {
  DataStore,
  TENANTS,
  isTenantId,
  tellerUser,
  tenantPassword,
  money,
  type Member,
  type TenantConfig,
} from "./data.js";
import * as pages from "./pages.js";
import { SESSION_COOKIE, SessionStore, parseCookies, type Session } from "./session.js";

interface Ctx {
  tenant: TenantConfig;
  session: Session | undefined;
}

function ctx(res: Response): Ctx {
  return res.locals.ctx as Ctx;
}

function html(res: Response, body: string, status = 200): void {
  res.status(status).type("html").send(body);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Only allow same-site relative/absolute-path targets for the interstitial "next" hop. */
function sanitizeNext(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw : "";
  if (!s || s.startsWith("//") || /[\s<>"']/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s))
    return fallback;
  return s;
}

function parseDeposit(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export interface LegacyCoreOptions {
  log?: boolean;
}

export function createLegacyCoreApp(opts: LegacyCoreOptions = {}): express.Express {
  const app = express();
  const data = new DataStore();
  const sessions = new SessionStore();
  const chaos = new ChaosController();

  app.disable("x-powered-by");
  app.set("etag", false);
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  if (opts.log) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        console.log(
          `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`,
        );
      });
      next();
    });
  }

  // ---------------------------------------------------------------- admin / test hooks
  app.get("/__health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/__chaos", (_req, res) => {
    res.json(chaos.status());
  });
  app.post("/__chaos", express.json(), (req, res) => {
    try {
      res.json(chaos.arm(req.body));
    } catch (err) {
      if (err instanceof ChaosError) res.status(400).json({ error: err.message });
      else throw err;
    }
  });
  app.post("/__chaos/reset", (_req, res) => {
    chaos.reset();
    res.json(chaos.status());
  });
  app.post("/__reset", (_req, res) => {
    data.reset();
    sessions.reset();
    chaos.reset();
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    html(res, pages.rootIndexPage(Object.values(TENANTS)));
  });

  // ---------------------------------------------------------------- tenant router
  const tenant = express.Router({ mergeParams: true });
  app.use("/t/:tenant", tenant);

  tenant.use((req, res, next) => {
    const raw = req.params.tenant;
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!isTenantId(id)) {
      html(res, pages.notFound404Page(`institution "${id ?? ""}"`), 404);
      return;
    }
    const t = TENANTS[id];
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    let session = sid ? sessions.get(sid) : undefined;
    if (session && session.tenant !== t.id) session = undefined;
    res.locals.ctx = { tenant: t, session } satisfies Ctx;
    next();
  });

  // Public, non-page routes (never subject to chaos).
  tenant.get("/", (req, res) => {
    const { tenant: t } = ctx(res);
    const pathOnly = req.originalUrl.split("?")[0] ?? "";
    if (!pathOnly.endsWith("/")) {
      res.redirect(301, `${pages.base(t)}/`);
      return;
    }
    html(res, pages.framesetPage(t));
  });
  tenant.get("/frames/banner", (_req, res) => {
    const { tenant: t, session } = ctx(res);
    html(res, pages.bannerPage(t, session?.user));
  });
  tenant.get("/frames/nav", (_req, res) => {
    const { tenant: t, session } = ctx(res);
    html(res, pages.navPage(t, Boolean(session)));
  });

  // Chaos interception applies to every tenant page route registered below.
  tenant.use(async (req, res, next) => {
    const fullPath = req.baseUrl + req.path;
    const scenario = chaos.consume(fullPath);
    if (!scenario) {
      next();
      return;
    }
    const { tenant: t, session } = ctx(res);
    const originalUrl = req.method === "GET" ? req.originalUrl : fullPath;
    switch (scenario) {
      case "slow":
        await sleep(chaos.delayMs);
        next();
        return;
      case "app_error":
        html(res, pages.appErrorPage(t), 500);
        return;
      case "session_expired":
        if (session) sessions.destroy(session.id);
        res.locals.ctx = { tenant: t, session: undefined } satisfies Ctx;
        html(res, pages.loginPage(t, { expired: true, reloadFrames: true }));
        return;
      case "maintenance_notice":
        if (session) session.noticeAcked = true;
        html(res, pages.noticePage(t, originalUrl));
        return;
      case "security_bulletin":
        html(res, pages.bulletinPage(t, originalUrl));
        return;
    }
  });

  tenant.get("/frames/main", (_req, res) => {
    const { tenant: t, session } = ctx(res);
    if (session) res.redirect(`${pages.base(t)}/home`);
    else html(res, pages.loginPage(t));
  });

  tenant.get("/login", (req, res) => {
    const { tenant: t } = ctx(res);
    html(
      res,
      pages.loginPage(t, { expired: req.query.expired === "1", off: req.query.off === "1" }),
    );
  });

  tenant.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const { tenant: t } = ctx(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const user = String(body[t.loginUserField] ?? "").trim();
    const pass = String(body[t.loginPassField] ?? "");
    if (user !== tellerUser() || pass !== tenantPassword(t)) {
      html(res, pages.loginPage(t, { error: "Invalid User ID or Password.", user }));
      return;
    }
    const session = sessions.create(user, t.id);
    res.cookie(SESSION_COOKIE, session.id, { httpOnly: true, path: "/", sameSite: "lax" });
    res.redirect(
      t.noticeAfterLogin ? `${pages.base(t)}/notice?next=home` : `${pages.base(t)}/home`,
    );
  });

  tenant.get("/logoff", (_req, res) => {
    const { tenant: t, session } = ctx(res);
    if (session) sessions.destroy(session.id);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    html(res, pages.loginPage(t, { off: true, reloadFrames: true }));
  });

  // Everything below requires a live session. Legacy style: render the sign-on page in place (HTTP 200).
  tenant.use((_req: Request, res: Response, next: NextFunction) => {
    const { tenant: t, session } = ctx(res);
    if (!session) {
      html(res, pages.loginPage(t, { expired: true, reloadFrames: true }));
      return;
    }
    next();
  });

  tenant.get("/home", (_req, res) => {
    const { tenant: t, session } = ctx(res);
    html(res, pages.homePage(t, session!.user));
  });

  tenant.get("/notice", (req, res) => {
    const { tenant: t, session } = ctx(res);
    if (session) session.noticeAcked = true;
    html(res, pages.noticePage(t, sanitizeNext(req.query.next, "home")));
  });

  tenant.get("/inquiry", (_req, res) => {
    const { tenant: t } = ctx(res);
    html(res, pages.inquiryFormPage(t));
  });

  tenant.post("/inquiry", express.urlencoded({ extended: false }), (req, res) => {
    const { tenant: t } = ctx(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const memberno = String(body[t.inquiryField] ?? "").trim();
    const lastname = String(body.lastname ?? "").trim();
    if (!memberno && !lastname) {
      html(
        res,
        pages.inquiryFormPage(t, {
          error: "Enter a Member Number or Last Name.",
          memberno,
          lastname,
        }),
      );
      return;
    }
    if (memberno && !/^\d+$/.test(memberno)) {
      html(
        res,
        pages.inquiryFormPage(t, { error: "Member Number must be numeric.", memberno, lastname }),
      );
      return;
    }
    let matches: Member[];
    if (memberno) {
      const m = data.getMember(t.id, memberno);
      matches = m ? [m] : [];
    } else {
      matches = data.findByLastName(t.id, lastname);
    }
    if (matches.length === 0) {
      html(res, pages.notFoundPage(t, memberno || lastname));
      return;
    }
    html(res, pages.resultsPage(t, matches));
  });

  /** Resolves the member for /member/:id routes, rendering not-found / access-denied pages. */
  function memberOr(res: Response, id: string | undefined): Member | undefined {
    const { tenant: t } = ctx(res);
    const m = id ? data.getMember(t.id, id) : undefined;
    if (!m) {
      html(res, pages.notFoundPage(t, id ?? ""));
      return undefined;
    }
    if (m.restricted) {
      html(res, pages.accessDeniedPage(t));
      return undefined;
    }
    return m;
  }

  tenant.get("/member/:id", (req, res) => {
    const { tenant: t } = ctx(res);
    const m = memberOr(res, req.params.id);
    if (!m) return;
    html(res, pages.memberProfilePage(t, m));
  });

  tenant.get("/member/:id/txn", (req, res) => {
    const { tenant: t } = ctx(res);
    const m = memberOr(res, req.params.id);
    if (!m) return;
    html(res, pages.stubPage(t, "Post Transaction", `${pages.base(t)}/member/${m.number}`));
  });

  tenant.get("/member/:id/close", (req, res) => {
    const { tenant: t } = ctx(res);
    const m = memberOr(res, req.params.id);
    if (!m) return;
    html(res, pages.stubPage(t, "Close Account", `${pages.base(t)}/member/${m.number}`));
  });

  tenant.get("/member/:id/share/new", (req, res) => {
    const { tenant: t } = ctx(res);
    const m = memberOr(res, req.params.id);
    if (!m) return;
    html(res, pages.newShareFormPage(t, m, { fundfrom: m.shares[0]?.id }));
  });

  interface ValidatedShare {
    values: Required<pages.NewShareValues>;
    deposit: number;
    fundFromLabel: string;
  }

  /** Validates new-share input; renders the form with an error and returns undefined on failure. */
  function validateNewShare(
    res: Response,
    m: Member,
    body: Record<string, unknown>,
  ): ValidatedShare | undefined {
    const { tenant: t } = ctx(res);
    const values: Required<pages.NewShareValues> = {
      sharetype: String(body.sharetype ?? ""),
      descr: String(body.descr ?? "").trim(),
      deposit: String(body.deposit ?? "").trim(),
      fundfrom: String(body.fundfrom ?? ""),
    };
    const fail = (error: string) => {
      html(res, pages.newShareFormPage(t, m, values, error));
      return undefined;
    };
    if (!(pages.SHARE_TYPES as readonly string[]).includes(values.sharetype))
      return fail("Select a valid Share Type.");
    if (!values.descr) return fail("Description is required.");
    const deposit = parseDeposit(values.deposit);
    if (deposit === null || deposit < 5) return fail("Initial deposit must be at least $5.00.");
    const funding = m.shares.find((s) => s.id === values.fundfrom);
    if (!funding) return fail("Select a valid funding share.");
    if (funding.available < deposit) return fail("Insufficient funds in funding share.");
    return {
      values,
      deposit,
      fundFromLabel: `${funding.id} - ${funding.type} (${money(funding.available)} available)`,
    };
  }

  tenant.post("/member/:id/share/new", express.urlencoded({ extended: false }), (req, res) => {
    const { tenant: t } = ctx(res);
    const m = memberOr(res, req.params.id);
    if (!m) return;
    const v = validateNewShare(res, m, (req.body ?? {}) as Record<string, unknown>);
    if (!v) return;
    html(res, pages.reviewNewSharePage(t, m, v.values, v.deposit, v.fundFromLabel));
  });

  tenant.post("/member/:id/share/confirm", express.urlencoded({ extended: false }), (req, res) => {
    const { tenant: t } = ctx(res);
    const m = memberOr(res, req.params.id);
    if (!m) return;
    const v = validateNewShare(res, m, (req.body ?? {}) as Record<string, unknown>);
    if (!v) return;
    const created = data.addShare(
      m,
      v.values.sharetype,
      v.values.descr,
      v.deposit,
      v.values.fundfrom,
    );
    const confirmation = `CNF-${randomBytes(4).toString("hex").toUpperCase()}`;
    html(res, pages.shareOpenedPage(t, m, created, confirmation, new Date()));
  });

  tenant.get("/transactions", (_req, res) => {
    const { tenant: t } = ctx(res);
    html(res, pages.stubPage(t, "Transactions", `${pages.base(t)}/home`));
  });

  tenant.get("/reports", (_req, res) => {
    const { tenant: t } = ctx(res);
    html(res, pages.stubPage(t, "Reports", `${pages.base(t)}/home`));
  });

  // ---------------------------------------------------------------- fallthrough + errors
  app.use((req, res) => {
    html(res, pages.notFound404Page(req.originalUrl), 404);
  });
  // Express recognises error handlers by arity; the unused `next` must stay.

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("LegacyCore unhandled error:", err);
    html(res, pages.appErrorPage(null), 500);
  });

  return app;
}

export interface RunningLegacyCore {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startLegacyCore(
  opts: { port?: number; log?: boolean } = {},
): Promise<RunningLegacyCore> {
  const app = createLegacyCoreApp({ log: opts.log });
  const server = createServer(app);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("could not determine listening port"));
    });
  });
  return {
    url: `http://localhost:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return path.resolve(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT ?? 4173);
  startLegacyCore({ port, log: process.env.LEGACYCORE_LOG !== "0" })
    .then((running) => {
      console.log(`LegacyCore listening on ${running.url}`);
      console.log(`  Summit FCU:      ${running.url}/t/summit/`);
      console.log(`  Cascade CCU:     ${running.url}/t/cascade/`);
      console.log(`  Chaos hooks:     POST ${running.url}/__chaos  (test-only)`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

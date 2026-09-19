import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLegacyCore, type RunningLegacyCore } from "../apps/legacycore/server.js";

/** Minimal cookie jar so tests drive the app the way a browser would. */
class Jar {
  private cookies = new Map<string, string>();
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === "") this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

let app: RunningLegacyCore;
const url = (p: string) => `${app.url}${p}`;

async function get(p: string, jar: Jar): Promise<Response> {
  const res = await fetch(url(p), { headers: { cookie: jar.header() }, redirect: "manual" });
  jar.absorb(res);
  return res;
}

async function post(p: string, form: Record<string, string>, jar: Jar): Promise<Response> {
  const res = await fetch(url(p), {
    method: "POST",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
  jar.absorb(res);
  return res;
}

async function chaos(body: Record<string, unknown>): Promise<Response> {
  return fetch(url("/__chaos"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loginSummit(jar: Jar): Promise<Response> {
  return post("/t/summit/login", { userid: "teller1", passwd: "Summit#2024!" }, jar);
}

beforeAll(async () => {
  app = await startLegacyCore({ port: 0 });
});

afterAll(async () => {
  await app.close();
});

describe("LegacyCore Teller Console", () => {
  it("serves the frameset shell", async () => {
    const res = await get("/t/summit/", new Jar());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<frameset");
    expect(body).toContain('name="banner"');
    expect(body).toContain('name="nav"');
    expect(body).toContain('name="main"');
    expect(body).toContain("Summit Federal Credit Union - Teller Console");
  });

  it("redirects a prefix without trailing slash so relative frame src resolves", async () => {
    const res = await get("/t/summit", new Jar());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/t/summit/");
  });

  it("rejects bad credentials", async () => {
    const jar = new Jar();
    const res = await post("/t/summit/login", { userid: "teller1", passwd: "wrong" }, jar);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Invalid User ID or Password.");
    expect(jar.get("LCSESSID")).toBeUndefined();
  });

  it("signs on, sets the session cookie, and shows the welcome page", async () => {
    const jar = new Jar();
    const res = await loginSummit(jar);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/t/summit/home");
    expect(jar.get("LCSESSID")).toMatch(/^[0-9a-f]{32}$/);
    const home = await get("/t/summit/home", jar);
    expect(await home.text()).toContain("Welcome, teller1");
    const nav = await get("/t/summit/frames/nav", jar);
    const navBody = await nav.text();
    expect(navBody).toContain("Member Inquiry");
    expect(navBody).toContain("Sign Off");
  });

  it("renders the expired sign-on page for unauthenticated protected routes (HTTP 200, legacy style)", async () => {
    const res = await get("/t/summit/inquiry", new Jar());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your session has expired. Please sign on again.");
  });

  it("reports a not-found member as a business outcome page", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const res = await post("/t/summit/inquiry", { memberno: "99999", lastname: "" }, jar);
    const body = await res.text();
    expect(body).toContain("No member found matching 99999.");
    expect(body).toContain("New Search");
  });

  it("validates non-numeric member numbers", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const res = await post("/t/summit/inquiry", { memberno: "ABC12", lastname: "" }, jar);
    expect(await res.text()).toContain("Member Number must be numeric.");
  });

  it("lists search results with javascript: links and shows the member profile", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const results = await post("/t/summit/inquiry", { memberno: "10023", lastname: "" }, jar);
    const resultsBody = await results.text();
    expect(resultsBody).toContain("Search Results");
    expect(resultsBody).toContain(`href="javascript:goMember('10023')"`);
    expect(resultsBody).toContain("Alice Johnson");
    const profile = await get("/t/summit/member/10023", jar);
    const profileBody = await profile.text();
    expect(profileBody).toContain("Member Profile");
    expect(profileBody).toContain("$4,250.37");
    expect(profileBody).toContain("***-**-4821");
    expect(profileBody).not.toMatch(/ id="/);
    expect(profileBody).not.toMatch(/<label/);
    expect(profileBody).not.toMatch(/<h[1-6]/);
  });

  it("denies access to a restricted member", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const res = await get("/t/summit/member/55555", jar);
    const body = await res.text();
    expect(body).toContain("Access Denied");
    expect(body).toContain("(Code R-401)");
  });

  it("validates the new share form", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const res = await post(
      "/t/summit/member/10023/share/new",
      { sharetype: "Savings", descr: "Vacation", deposit: "1", fundfrom: "0001" },
      jar,
    );
    const body = await res.text();
    expect(body).toContain("Initial deposit must be at least $5.00.");
    expect(body).toContain('value="Vacation"');
  });

  it("reviews then confirms a new share and shows a confirmation number", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const form = {
      sharetype: "Club Savings",
      descr: "Holiday Club",
      deposit: "25.00",
      fundfrom: "0001",
    };
    const review = await post("/t/summit/member/10023/share/new", form, jar);
    const reviewBody = await review.text();
    expect(reviewBody).toContain("Review New Share");
    expect(reviewBody).toContain("return confirm(");
    expect(reviewBody).toContain('value="Confirm"');
    const confirm = await post("/t/summit/member/10023/share/confirm", form, jar);
    const confirmBody = await confirm.text();
    expect(confirmBody).toContain("Share Opened");
    expect(confirmBody).toContain("New share opened successfully.");
    expect(confirmBody).toMatch(/CNF-[0-9A-F]{8}/);
    expect(confirmBody).toContain("0030");
    const profile = await (await get("/t/summit/member/10023", jar)).text();
    expect(profile).toContain("Holiday Club");
    expect(profile).toContain("$4,225.37"); // 4250.37 - 25.00 debited from the funding share
  });

  it("chaos: app_error returns 500 once, then normal service resumes", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    const armed = await chaos({ scenario: "app_error", count: 1 });
    expect(armed.status).toBe(200);
    const first = await get("/t/summit/inquiry", jar);
    expect(first.status).toBe(500);
    expect(await first.text()).toContain("Application Error");
    const second = await get("/t/summit/inquiry", jar);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Member Inquiry");
  });

  it("chaos: session_expired destroys the session and renders the expired page", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    await chaos({ scenario: "session_expired", count: 1 });
    const res = await get("/t/summit/member/10023", jar);
    expect(await res.text()).toContain("Your session has expired. Please sign on again.");
    const again = await get("/t/summit/member/10023", jar);
    expect(await again.text()).toContain("Your session has expired. Please sign on again.");
  });

  it("chaos: security_bulletin interstitial links back to the original URL", async () => {
    const jar = new Jar();
    await loginSummit(jar);
    await chaos({ scenario: "security_bulletin", count: 1, pathPattern: "/member/" });
    const res = await get("/t/summit/member/10023", jar);
    const body = await res.text();
    expect(body).toContain("Security Bulletin");
    expect(body).toContain("I Acknowledge");
    expect(body).toContain("location.href='/t/summit/member/10023'");
    await fetch(url("/__chaos/reset"), { method: "POST" });
  });

  it("chaos: rejects an unknown scenario", async () => {
    const res = await chaos({ scenario: "meltdown" });
    expect(res.status).toBe(400);
  });

  it("cascade tenant shows the System Notice after logon and uses its own labels", async () => {
    const jar = new Jar();
    const login = await post("/t/cascade/login", { uid: "teller1", pwd: "Cascade#2024!" }, jar);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/t/cascade/notice?next=home");
    const notice = await get("/t/cascade/notice?next=home", jar);
    const noticeBody = await notice.text();
    expect(noticeBody).toContain("System Notice");
    expect(noticeBody).toContain('value="Continue"');
    expect(noticeBody).toContain("location.href='home'");
    const inquiry = await (await get("/t/cascade/inquiry", jar)).text();
    expect(inquiry).toContain("Member #");
    expect(inquiry).toContain('name="mbr_num"');
    expect(inquiry).toContain('value="Find"');
    const nav = await (await get("/t/cascade/frames/nav", jar)).text();
    expect(nav).toContain("Member Lookup");
    const profile = await (await get("/t/cascade/member/10023", jar)).text();
    expect(profile).toContain("Alicia Johnston");
    expect(profile.indexOf('<td class="th">Type</td>')).toBeLessThan(
      profile.indexOf('<td class="th">Share ID</td>'),
    );
  });

  it("unknown tenant is a 404", async () => {
    const res = await get("/t/nowhere/", new Jar());
    expect(res.status).toBe(404);
  });

  it("__reset restores seed data", async () => {
    const res = await fetch(url("/__reset"), { method: "POST" });
    expect(res.status).toBe(200);
    const jar = new Jar();
    await loginSummit(jar);
    const profile = await (await get("/t/summit/member/10023", jar)).text();
    expect(profile).toContain("$4,250.37");
    expect(profile).not.toContain("Holiday Club");
  });
});

/**
 * HTML rendering for the LegacyCore Teller Console.
 *
 * Deliberately hostile to automation, the way real back-office apps are:
 * framesets, table layouts, <font> tags, bgcolor attributes, generic class names,
 * NO ids, NO data-testids, NO <label>, NO ARIA, NO <h1>-<h6>. Headings are bold
 * text in a <td class="hdr">. Buttons are <input type="button"> with inline onclick.
 */
import {
  ACCOUNT_COLUMN_LABELS,
  type Member,
  type Share,
  type TenantConfig,
  money,
} from "./data.js";

export function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape for use inside a single-quoted JS string that itself lives in an HTML attribute. */
export function jsAttr(s: string): string {
  return esc(s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
}

export function base(t: TenantConfig): string {
  return `/t/${t.id}`;
}

const FONT = `<font face="Verdana, Arial, Helvetica" size="2">`;

function heading(text: string, color = "#1f3a5f"): string {
  return `<table border=0 cellpadding=2 cellspacing=0 width="100%"><tr><td class="hdr"><font face="Verdana, Arial" size="4" color="${color}"><b>${esc(text)}</b></font></td></tr></table>`;
}

function subheading(text: string, color = "#1f3a5f"): string {
  return `<table border=0 cellpadding=2 cellspacing=0 width="100%"><tr><td class="hdr"><font face="Verdana, Arial" size="3" color="${color}"><b>${esc(text)}</b></font></td></tr></table>`;
}

function errorRow(msg: string | undefined, colspan = 2): string {
  if (!msg) return "";
  return `<tr><td class="err" colspan="${colspan}"><font face="Verdana, Arial" size="2" color="#cc0000"><b>${esc(msg)}</b></font></td></tr>`;
}

function infoRow(msg: string | undefined, colspan = 2): string {
  if (!msg) return "";
  return `<tr><td class="info" colspan="${colspan}">${FONT}${esc(msg)}</font></td></tr>`;
}

function text(s: string): string {
  return `${FONT}${esc(s)}</font>`;
}

function link(href: string, label: string, target?: string): string {
  return `${FONT}<a href="${esc(href)}"${target ? ` target="${esc(target)}"` : ""}>${esc(label)}</a></font>`;
}

/** Tenant-neutral document shell. */
export function layout(
  t: TenantConfig | null,
  title: string,
  body: string,
  extraHead = "",
): string {
  const color = t?.bannerColor ?? "#1f3a5f";
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${esc(title)}</title>
<style type="text/css">
body { margin: 8px; background-color: #ffffff; }
td { font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 11px; }
td.hdr { padding: 6px 4px 10px 4px; }
td.err { padding: 4px 6px; background-color: #fff3f3; border: 1px solid #cc0000; }
td.info { padding: 4px 6px; background-color: #f3f7ff; border: 1px solid ${color}; }
td.lbl { text-align: right; padding-right: 8px; white-space: nowrap; }
td.th { background-color: #d9e1ec; font-weight: bold; white-space: nowrap; }
td.num { text-align: right; white-space: nowrap; }
tr.c1 { background-color: #ffffff; }
tr.c2 { background-color: #eef2f7; }
table.grid td { border-bottom: 1px solid #c8d0dc; }
input, select { font-family: Verdana, Arial, sans-serif; font-size: 11px; }
a { color: ${color}; }
</style>${extraHead}
</head>
<body bgcolor="#ffffff" text="#000000" link="${color}" vlink="${color}">
${body}
</body>
</html>`;
}

/** Reloads sibling frames so the nav/banner reflect the new sign-on state (the spec'd legacy trick). */
export const FRAME_RELOAD_SCRIPT = `<script type="text/javascript">try{if(parent&&parent.frames&&parent.frames['nav']){parent.frames['nav'].location.reload();parent.frames['banner'].location.reload();}}catch(e){}</script>`;

export function framesetPage(t: TenantConfig): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN" "http://www.w3.org/TR/html4/frameset.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${esc(t.institution)} - Teller Console</title>
</head>
<frameset rows="64,*" border="1" frameborder="1">
<frame name="banner" src="frames/banner" scrolling="no" noresize>
<frameset cols="170,*" border="1" frameborder="1">
<frame name="nav" src="frames/nav" scrolling="auto">
<frame name="main" src="frames/main" scrolling="auto">
</frameset>
<noframes><body>This application requires a browser that supports frames.</body></noframes>
</frameset>
</html>`;
}

export function bannerPage(t: TenantConfig, user: string | undefined): string {
  const body = `<table border=0 cellpadding=6 cellspacing=0 width="100%" height="100%" bgcolor="${t.bannerColor}">
<tr>
<td valign="middle"><font face="Verdana, Arial" size="4" color="#ffffff"><b>${esc(t.institution)}</b></font><br>
<font face="Verdana, Arial" size="1" color="#dde6f0">Teller Console v7.3</font></td>
<td valign="middle" align="right"><font face="Verdana, Arial" size="2" color="#ffffff">${user ? `Signed on as: <b>${esc(user)}</b>` : "Not signed on"}</font></td>
</tr>
</table>`;
  return layout(t, "Banner", body).replace(
    '<body bgcolor="#ffffff"',
    `<body bgcolor="${t.bannerColor}" style="margin:0"`,
  );
}

export function navPage(t: TenantConfig, authenticated: boolean): string {
  const b = base(t);
  const rows = authenticated
    ? [
        [`${b}/inquiry`, t.inquiryNavText],
        [`${b}/transactions`, "Transactions"],
        [`${b}/reports`, "Reports"],
        [`${b}/logoff`, "Sign Off"],
      ]
    : [[`${b}/login`, "Sign On"]];
  const body = `<table border=0 cellpadding=4 cellspacing=0 width="100%" bgcolor="#eef2f7">
<tr><td class="th">${FONT}<b>Functions</b></font></td></tr>
${rows.map(([href, label]) => `<tr><td>${link(href!, label!, "main")}</td></tr>`).join("\n")}
</table>`;
  return layout(t, "Navigation", body).replace(
    '<body bgcolor="#ffffff"',
    '<body bgcolor="#eef2f7"',
  );
}

export interface LoginOpts {
  error?: string;
  expired?: boolean;
  off?: boolean;
  reloadFrames?: boolean;
  user?: string;
}

export function loginPage(t: TenantConfig, o: LoginOpts = {}): string {
  const notice = o.expired
    ? errorRow("Your session has expired. Please sign on again.")
    : o.off
      ? infoRow("You have been signed off.")
      : "";
  const body = `${heading("Sign On", t.bannerColor)}
<form method="post" action="${base(t)}/login">
<table border=0 cellpadding=2 cellspacing=0>
${notice}
${errorRow(o.error)}
<tr><td class="lbl">${text("User ID")}</td><td><input type="text" name="${t.loginUserField}" size="16" maxlength="16" value="${esc(o.user ?? "")}"></td></tr>
<tr><td class="lbl">${text("Password")}</td><td><input type="password" name="${t.loginPassField}" size="16" maxlength="32"></td></tr>
<tr><td></td><td><input type="submit" value="${esc(t.loginButton)}"></td></tr>
</table>
</form>
${o.reloadFrames ? FRAME_RELOAD_SCRIPT : ""}`;
  return layout(t, `${t.institution} - Sign On`, body);
}

export function homePage(t: TenantConfig, user: string): string {
  const body = `${heading(`Welcome, ${user}`, t.bannerColor)}
<table border=0 cellpadding=2 cellspacing=0><tr><td>${text("Select a function from the menu at left.")}</td></tr></table>
${FRAME_RELOAD_SCRIPT}`;
  return layout(t, `${t.institution} - Home`, body);
}

export function noticePage(t: TenantConfig, next: string): string {
  const body = `${heading("System Notice", t.bannerColor)}
<table border=0 cellpadding=4 cellspacing=0 width="70%">
${infoRow("Scheduled maintenance: the core will be unavailable Sunday 02:00-04:00 ET. Please complete all postings before then.", 1)}
<tr><td><input type="button" value="Continue" onclick="location.href='${jsAttr(next)}'"></td></tr>
</table>`;
  return layout(t, `${t.institution} - System Notice`, body);
}

export function bulletinPage(t: TenantConfig, next: string): string {
  const body = `${heading("Security Bulletin", "#8a1c1c")}
<table border=0 cellpadding=4 cellspacing=0 width="70%">
${errorRow("Mandatory acknowledgement: phishing awareness training is due by month end.", 1)}
<tr><td><input type="button" value="I Acknowledge" onclick="location.href='${jsAttr(next)}'"></td></tr>
</table>`;
  return layout(t, `${t.institution} - Security Bulletin`, body);
}

export interface InquiryFormOpts {
  error?: string;
  memberno?: string;
  lastname?: string;
}

export function inquiryFormPage(t: TenantConfig, o: InquiryFormOpts = {}): string {
  const body = `${heading("Member Inquiry", t.bannerColor)}
<form method="post" action="${base(t)}/inquiry">
<table border=0 cellpadding=2 cellspacing=0>
${errorRow(o.error)}
<tr><td class="lbl">${text(t.inquiryLabel)}</td><td><input type="text" name="${t.inquiryField}" size="12" maxlength="10" value="${esc(o.memberno ?? "")}"></td></tr>
<tr><td class="lbl">${text("Last Name")}</td><td><input type="text" name="lastname" size="24" maxlength="40" value="${esc(o.lastname ?? "")}"></td></tr>
<tr><td></td><td><input type="button" value="${esc(t.inquiryButton)}" onclick="document.forms[0].submit()"></td></tr>
</table>
</form>`;
  return layout(t, `${t.institution} - Member Inquiry`, body);
}

export function notFoundPage(t: TenantConfig, query: string): string {
  const body = `${heading("Member Inquiry", t.bannerColor)}
<table border=0 cellpadding=4 cellspacing=0>
<tr><td>${text(`No member found matching ${query}.`)}</td></tr>
<tr><td>${link(`${base(t)}/inquiry`, "New Search")}</td></tr>
</table>`;
  return layout(t, `${t.institution} - Member Inquiry`, body);
}

export function resultsPage(t: TenantConfig, members: Member[]): string {
  const rows = members
    .map(
      (m, i) => `<tr class="${i % 2 ? "c2" : "c1"}">
<td><a href="javascript:goMember('${jsAttr(m.number)}')">${esc(m.number)}</a></td>
<td>${esc(m.name)}</td>
<td>${m.restricted ? "RESTRICTED" : "Active"}</td>
</tr>`,
    )
    .join("\n");
  const body = `${heading("Search Results", t.bannerColor)}
<table class="grid" border=0 cellpadding=3 cellspacing=0 width="60%">
<tr><td class="th">Member #</td><td class="th">Name</td><td class="th">Status</td></tr>
${rows}
</table>
<br>
${link(`${base(t)}/inquiry`, "New Search")}
<script type="text/javascript">function goMember(n){location.href='member/'+n;}</script>`;
  return layout(t, `${t.institution} - Search Results`, body);
}

export function accessDeniedPage(t: TenantConfig): string {
  const body = `${heading("Access Denied", "#8a1c1c")}
<table border=0 cellpadding=4 cellspacing=0 width="70%">
${errorRow("You are not authorized to view this account. (Code R-401) Contact a supervisor.", 1)}
<tr><td>${link(`${base(t)}/inquiry`, "Back to Search")}</td></tr>
</table>`;
  return layout(t, `${t.institution} - Access Denied`, body);
}

function accountsTable(t: TenantConfig, shares: Share[]): string {
  const cell = (s: Share, col: (typeof t.accountColumns)[number]): string => {
    switch (col) {
      case "shareId":
        return `<td>${esc(s.id)}</td>`;
      case "type":
        return `<td>${esc(s.type)}</td>`;
      case "description":
        return `<td>${esc(s.description)}</td>`;
      case "balance":
        return `<td class="num">${esc(money(s.balance))}</td>`;
      case "available":
        return `<td class="num">${esc(money(s.available))}</td>`;
    }
  };
  const header = t.accountColumns
    .map((c) => `<td class="th">${esc(ACCOUNT_COLUMN_LABELS[c])}</td>`)
    .join("");
  const rows = shares
    .map(
      (s, i) =>
        `<tr class="${i % 2 ? "c2" : "c1"}">${t.accountColumns.map((c) => cell(s, c)).join("")}</tr>`,
    )
    .join("\n");
  return `<table class="grid" border=0 cellpadding=3 cellspacing=0 width="80%">
<tr>${header}</tr>
${rows}
</table>`;
}

export function memberProfilePage(t: TenantConfig, m: Member): string {
  const b = base(t);
  const row = (label: string, value: string) =>
    `<tr><td class="lbl">${text(label)}</td><td>${text(value)}</td></tr>`;
  const body = `${heading("Member Profile", t.bannerColor)}
<table border=0 cellpadding=2 cellspacing=0>
${row("Member #", m.number)}
${row("Name", m.name)}
${row("Address", m.address)}
${row("Phone", m.phone)}
${row("SSN", m.ssnMasked)}
${row("Member Since", m.memberSince)}
${row("Status", m.restricted ? "RESTRICTED" : "Active")}
</table>
${subheading("Accounts", t.bannerColor)}
${accountsTable(t, m.shares)}
<br>
<table border=0 cellpadding=2 cellspacing=0>
<tr>
<td><input type="button" value="New Share" onclick="location.href='${jsAttr(`${b}/member/${m.number}/share/new`)}'"></td>
<td><input type="button" value="Post Transaction" onclick="location.href='${jsAttr(`${b}/member/${m.number}/txn`)}'"></td>
<td><input type="button" value="Close Account" onclick="location.href='${jsAttr(`${b}/member/${m.number}/close`)}'"></td>
</tr>
</table>
<br>
${link(`${b}/inquiry`, "Back to Search")}`;
  return layout(t, `${t.institution} - Member Profile`, body);
}

export interface NewShareValues {
  sharetype?: string;
  descr?: string;
  deposit?: string;
  fundfrom?: string;
}

export const SHARE_TYPES = ["Savings", "Club Savings", "Money Market"] as const;

export function newShareFormPage(
  t: TenantConfig,
  m: Member,
  v: NewShareValues = {},
  error?: string,
): string {
  const b = base(t);
  const typeOptions = SHARE_TYPES.map(
    (s) => `<option value="${esc(s)}"${v.sharetype === s ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  const fundOptions = m.shares
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${v.fundfrom === s.id ? " selected" : ""}>${esc(`${s.id} - ${s.type}`)}</option>`,
    )
    .join("");
  const body = `${heading("New Share", t.bannerColor)}
<table border=0 cellpadding=2 cellspacing=0>
<tr><td class="lbl">${text("Member")}</td><td>${text(`${m.number} - ${m.name}`)}</td></tr>
</table>
<form method="post" action="new">
<table border=0 cellpadding=2 cellspacing=0>
${errorRow(error)}
<tr><td class="lbl">${text("Share Type")}</td><td><select name="sharetype">${typeOptions}</select></td></tr>
<tr><td class="lbl">${text("Description")}</td><td><input type="text" name="descr" size="30" maxlength="40" value="${esc(v.descr ?? "")}"></td></tr>
<tr><td class="lbl">${text("Initial Deposit")}</td><td><input type="text" name="deposit" size="10" maxlength="12" value="${esc(v.deposit ?? "")}"></td></tr>
<tr><td class="lbl">${text("Fund From")}</td><td><select name="fundfrom">${fundOptions}</select></td></tr>
<tr><td></td><td><input type="button" value="Review" onclick="document.forms[0].submit()"> &nbsp; ${link(`${b}/member/${m.number}`, "Cancel")}</td></tr>
</table>
</form>`;
  return layout(t, `${t.institution} - New Share`, body);
}

export function reviewNewSharePage(
  t: TenantConfig,
  m: Member,
  v: Required<NewShareValues>,
  depositAmount: number,
  fundFromLabel: string,
): string {
  const b = base(t);
  const row = (label: string, value: string) =>
    `<tr><td class="lbl">${text(label)}</td><td>${text(value)}</td></tr>`;
  const body = `${heading("Review New Share", t.bannerColor)}
<table border=0 cellpadding=2 cellspacing=0>
${row("Member", `${m.number} - ${m.name}`)}
${row("Share Type", v.sharetype)}
${row("Description", v.descr)}
${row("Initial Deposit", money(depositAmount))}
${row("Fund From", fundFromLabel)}
</table>
<br>
<form method="post" action="confirm">
<input type="hidden" name="sharetype" value="${esc(v.sharetype)}">
<input type="hidden" name="descr" value="${esc(v.descr)}">
<input type="hidden" name="deposit" value="${esc(v.deposit)}">
<input type="hidden" name="fundfrom" value="${esc(v.fundfrom)}">
<table border=0 cellpadding=2 cellspacing=0>
<tr><td><input type="submit" value="${esc(t.confirmButton)}" onclick="return confirm('${jsAttr(`Post this new share to member ${m.number}?`)}')"> &nbsp; ${link(`${b}/member/${m.number}`, "Cancel")}</td></tr>
</table>
</form>`;
  return layout(t, `${t.institution} - Review New Share`, body);
}

export function shareOpenedPage(
  t: TenantConfig,
  m: Member,
  s: Share,
  confirmation: string,
  posted: Date,
): string {
  const b = base(t);
  const row = (label: string, value: string) =>
    `<tr><td class="lbl">${text(label)}</td><td>${text(value)}</td></tr>`;
  const body = `${heading("Share Opened", t.bannerColor)}
<table border=0 cellpadding=4 cellspacing=0 width="70%">
${infoRow("New share opened successfully.", 1)}
</table>
<table border=0 cellpadding=2 cellspacing=0>
${row("Confirmation Number", confirmation)}
${row("Share ID", s.id)}
${row("Share Type", s.type)}
${row("Description", s.description)}
${row("Initial Deposit", money(s.balance))}
${row("Posted", posted.toLocaleString("en-US", { hour12: false }))}
</table>
<br>
${link(`${b}/member/${m.number}`, "Return to Member")}`;
  return layout(t, `${t.institution} - Share Opened`, body);
}

export function stubPage(t: TenantConfig, functionName: string, backHref: string): string {
  const body = `${heading(functionName, t.bannerColor)}
<table border=0 cellpadding=4 cellspacing=0>
<tr><td>${text("Function not available in this release.")}</td></tr>
<tr><td>${link(backHref, "Back")}</td></tr>
</table>`;
  return layout(t, `${t.institution} - ${functionName}`, body);
}

export function appErrorPage(t: TenantConfig | null): string {
  const body = `${heading("Application Error", "#8a1c1c")}
<table border=0 cellpadding=4 cellspacing=0 width="70%">
${errorRow("An unexpected error occurred (ref 0x4F2A). Contact Support.", 1)}
</table>`;
  return layout(t, "Application Error", body);
}

export function notFound404Page(what: string): string {
  const body = `${heading("Not Found", "#8a1c1c")}
<table border=0 cellpadding=4 cellspacing=0>
<tr><td>${text(`The requested resource was not found: ${what}`)}</td></tr>
</table>`;
  return layout(null, "Not Found", body);
}

export function rootIndexPage(tenants: TenantConfig[]): string {
  const rows = tenants
    .map(
      (t) =>
        `<tr><td>${link(`${base(t)}/`, t.institution)}</td><td>${text(`/t/${t.id}/`)}</td></tr>`,
    )
    .join("\n");
  const body = `${heading("LegacyCore Teller Console")}
<table border=0 cellpadding=4 cellspacing=0>
<tr><td class="th">Institution</td><td class="th">Path</td></tr>
${rows}
</table>
<br>${text("Mock legacy core-banking console for automation testing. All data is fictional.")}`;
  return layout(null, "LegacyCore", body);
}

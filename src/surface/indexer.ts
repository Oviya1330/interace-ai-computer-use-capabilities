/**
 * Browser-side element indexer, injected into every frame (framesets and iframes included).
 * Pure JS in a string so it can be evaluated in any frame regardless of page markup.
 *
 * Exposes window.__cua with:
 *   index(opts)            -> registry entries (interactive + readable elements)
 *   elementAt(i)           -> element for a registry index
 *   describeAt(x, y)       -> entry for the element under a point (used to record human actions)
 *   findByLabel(text, ctl) -> controls labelled by adjacent/associated text
 *   findByText(text, tag, exact)
 *   findTableCell(spec)    -> cells located relationally in a table
 *   mark(entries) / unmark() -> numbered overlay boxes (set-of-marks) for screenshots
 *   visibleText() / signature()
 */
export const INDEXER_VERSION = 7;

export const INDEXER_SCRIPT = String.raw`
(() => {
  if (window.__cua && window.__cua.v === ${INDEXER_VERSION}) return;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,[onclick],[role=button],[role=link],[role=textbox],[role=combobox],[role=checkbox],[role=menuitem],[tabindex]:not([tabindex="-1"]),summary';
  const READABLE = new Set(['TD','TH','SPAN','DIV','P','LI','FONT','B','STRONG','EM','I','U','LABEL','LEGEND','CAPTION','H1','H2','H3','H4','H5','H6','DT','DD','PRE','CODE','CENTER','SMALL','BIG']);
  const INLINE = new Set(['B','STRONG','I','EM','U','FONT','SPAN','A','SMALL','BIG','SUP','SUB','CODE','LABEL','NOBR']);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const stripColon = (s) => norm(s).replace(/[:：]\s*$/, '');
  let registry = [];
  let maskRes = [];
  const isMasked = (e) => maskRes.length > 0 && maskRes.some((re) => (e.labelText && re.test(e.labelText)) || (e.table && e.table.columnHeader && re.test(e.table.columnHeader)) || (e.attrs.name && re.test(e.attrs.name)) || (e.attrs['aria-label'] && re.test(e.attrs['aria-label'])));

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight + 4000 || r.left > innerWidth + 200) return false;
    return true;
  }
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) t += n.textContent;
      else if (n.nodeType === 1 && INLINE.has(n.tagName) && !n.matches(INTERACTIVE)) t += ownText(n);
    }
    return norm(t);
  }
  function isControl(el) { return el.matches('input:not([type=hidden]),select,textarea,button'); }
  function role(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    const type = ((el.getAttribute('type') || 'text')).toLowerCase();
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'password') return 'password';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'OPTION') return 'option';
    if (tag === 'TD') return 'cell';
    if (tag === 'TH') return 'columnheader';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return 'img';
    if (tag === 'LI') return 'listitem';
    if (el.hasAttribute('onclick')) return 'button';
    return 'text';
  }
  function labelsText(el) {
    try {
      if (el.labels && el.labels.length) return norm([...el.labels].map((l) => l.textContent).join(' '));
    } catch (e) {}
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    return '';
  }
  function accName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => norm(e.textContent)).join(' ');
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return norm(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      if (type === 'image') return norm(el.alt || el.title);
      return labelsText(el) || norm(el.placeholder || el.title || '');
    }
    if (tag === 'SELECT' || tag === 'TEXTAREA') return labelsText(el) || norm(el.title || '');
    if (tag === 'IMG') return norm(el.alt || el.title);
    return norm(el.textContent);
  }
  // Legacy-layout label heuristic: adjacent cell / preceding text.
  function nearbyLabel(el, cellsOnly) {
    const cell = el.closest('td,th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev && !norm(prev.textContent)) prev = prev.previousElementSibling;
      if (prev) {
        const t = stripColon(prev.textContent);
        if (t && t.length <= 60 && !prev.querySelector('input,select,textarea,button')) return t;
      }
      if (cellsOnly || cell === el) return '';
      // text inside the same cell before the control
      let t = '';
      for (const n of cell.childNodes) { if (n === el || n.contains(el)) break; if (n.nodeType === 3) t += n.textContent; else if (n.nodeType === 1 && !isControl(n)) t += n.textContent; }
      t = stripColon(t);
      if (t && t.length <= 60) return t;
    }
    let p = el.previousSibling;
    let t = '';
    while (p && t.length < 60) { if (p.nodeType === 3) t = p.textContent + t; else if (p.nodeType === 1 && !isControl(p)) { t = p.textContent + t; break; } p = p.previousSibling; }
    t = stripColon(t);
    if (t && t.length <= 60) return t;
    const ps = el.parentElement && el.parentElement.previousElementSibling;
    if (ps && !ps.querySelector('input,select,textarea,button')) { const t2 = stripColon(ps.textContent); if (t2 && t2.length <= 60) return t2; }
    return '';
  }
  function headerRowIndex(table) {
    const rows = [...table.rows];
    let i = rows.findIndex((r) => [...r.cells].some((c) => c.tagName === 'TH'));
    return i < 0 ? 0 : i;
  }
  function tableCtx(el) {
    const cell = el.closest('td,th');
    if (!cell) return null;
    const tr = cell.parentElement;
    const table = cell.closest('table');
    if (!tr || !table) return null;
    const rows = [...table.rows];
    const rowIndex = rows.indexOf(tr);
    if (rowIndex < 0) return null;
    const hri = headerRowIndex(table);
    const headers = [...rows[hri].cells].map((c) => norm(c.textContent));
    const colIndex = [...tr.cells].indexOf(cell);
    return {
      headers, headerRowIndex: hri, rowIndex, dataRowIndex: rowIndex - hri - 1, colIndex,
      columnHeader: headers[colIndex] || '', rowCells: [...tr.cells].map((c) => norm(c.textContent)), isHeader: rowIndex === hri,
    };
  }
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML') {
      const tag = cur.tagName.toLowerCase();
      let sel = tag;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      if (tag === 'body') break;
      cur = parent;
    }
    return parts.join(' > ');
  }
  function xpath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      let idx = 1;
      if (parent) { const same = [...parent.children].filter((c) => c.tagName === cur.tagName); idx = same.indexOf(cur) + 1; }
      parts.unshift(tag + '[' + idx + ']');
      cur = parent;
    }
    return '/' + parts.join('/');
  }
  function formSubmitLabels(el) {
    const f = el.form || el.closest('form');
    if (!f) return [];
    return [...f.querySelectorAll('input[type=submit],button,input[type=button]')].map((b) => norm(b.value || b.textContent)).filter(Boolean);
  }
  function rect(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function entryFor(el, i, interactive) {
    const tag = el.tagName.toLowerCase();
    const r = role(el);
    const type = (el.getAttribute('type') || '').toLowerCase();
    const sensitive = r === 'password' || /ssn|social|passw|secret|token|card/i.test(el.getAttribute('name') || '');
    const attrs = {};
    for (const a of ['name', 'id', 'type', 'href', 'placeholder', 'class', 'title', 'alt', 'for']) { const v = el.getAttribute(a); if (v) attrs[a] = v; }
    if (['button', 'submit', 'reset'].includes(type) && el.value) attrs.value = el.value;
    let value;
    if (isControl(el) && !['button', 'submit', 'reset', 'image'].includes(type)) {
      if (r === 'password') value = el.value ? '••••••' : '';
      else if (el.tagName === 'SELECT') value = el.selectedOptions && el.selectedOptions[0] ? norm(el.selectedOptions[0].textContent) : '';
      else if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked';
      else value = el.value;
    }
    const text = isControl(el) ? (['button', 'submit', 'reset'].includes(type) ? norm(el.value) : '') : ownText(el);
    let probe = el;
    while (probe.children.length === 1 && INLINE.has(probe.children[0].tagName) && norm(probe.children[0].textContent) === norm(probe.textContent)) probe = probe.children[0];
    const cs = getComputedStyle(probe);
    const bold = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold' || !!probe.closest('b,strong') || !!probe.querySelector('b,strong');
    const e = {
      index: i, tag, role: r, name: accName(el), text, attrs, localBbox: rect(el), interactive,
      disabled: !!el.disabled, sensitive, fontSize: parseFloat(cs.fontSize) || 0, bold,
      css: cssPath(el), xpath: xpath(el),
    };
    if (value !== undefined) e.value = value;
    if (isControl(el)) { const l = nearbyLabel(el, false); if (l) e.labelText = l; e.formSubmitLabels = formSubmitLabels(el); }
    else if (tag === 'td' || tag === 'th') { const l = nearbyLabel(el, true); if (l && l !== text) e.labelText = l; }
    const t = tableCtx(el);
    if (t && t.headers.length >= 2) e.table = t;
    if (!e.sensitive && isMasked(e)) e.sensitive = true;
    return e;
  }
  function index(opts) {
    opts = opts || {};
    const maxReadable = opts.maxReadable || 200;
    maskRes = (opts.maskPatterns || []).map((p) => new RegExp(p, 'i'));
    registry = [];
    const entries = [];
    const all = document.querySelectorAll('*');
    const interactiveSet = new Set();
    for (const el of all) {
      if (el.matches(INTERACTIVE) && !el.closest('[data-cua-marks]')) {
        if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
        if (!visible(el)) continue;
        interactiveSet.add(el);
      }
    }
    for (const el of interactiveSet) { registry.push(el); entries.push(entryFor(el, registry.length - 1, true)); }
    let readable = 0;
    for (const el of all) {
      if (readable >= maxReadable) break;
      if (!READABLE.has(el.tagName) || interactiveSet.has(el)) continue;
      if (el.closest('[data-cua-marks]')) continue;
      if (el.closest('option,select,textarea')) continue;
      const t = ownText(el);
      if (!t) continue;
      if (!visible(el)) continue;
      // skip wrappers whose text is entirely an interactive child's text
      if (el.children.length && [...el.children].some((c) => interactiveSet.has(c) && norm(c.textContent) === t)) continue;
      // skip inline elements inside a readable parent with the same text (font/b nested in td)
      const p = el.parentElement;
      if (p && READABLE.has(p.tagName) && INLINE.has(el.tagName) && ownText(p) === t) continue;
      registry.push(el);
      entries.push(entryFor(el, registry.length - 1, false));
      readable++;
    }
    return entries;
  }
  function elementAt(i) { return registry[i] || null; }
  function register(el) {
    let idx = registry.indexOf(el);
    if (idx < 0) { registry.push(el); idx = registry.length - 1; }
    return entryFor(el, idx, el.matches(INTERACTIVE));
  }
  function describeAt(x, y) {
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    let cur = el;
    while (cur && cur !== document.body && !(cur.matches(INTERACTIVE) || READABLE.has(cur.tagName))) cur = cur.parentElement;
    if (!cur || cur === document.body) cur = el;
    let idx = registry.indexOf(cur);
    if (idx < 0) { registry.push(cur); idx = registry.length - 1; }
    return entryFor(cur, idx, cur.matches(INTERACTIVE));
  }
  function controlMatches(el, ctl) {
    if (!ctl || ctl === 'any') return isControl(el);
    const r = role(el);
    if (ctl === 'textbox') return r === 'textbox' || r === 'password';
    if (ctl === 'combobox') return r === 'combobox';
    return r === ctl;
  }
  function findByLabel(text, ctl) {
    const want = stripColon(text).toLowerCase();
    const out = [];
    const push = (c) => { if (c && controlMatches(c, ctl) && visible(c) && !out.includes(c)) out.push(c); };
    for (const el of document.querySelectorAll('label,td,th,span,font,b,strong,div,dt,legend,p,li')) {
      if (stripColon(ownText(el)).toLowerCase() !== want && stripColon(el.textContent).toLowerCase() !== want) continue;
      if (ctl === 'value') {
        const cell = el.closest('td,th');
        if (!cell) continue;
        let next = cell.nextElementSibling;
        while (next && !norm(next.textContent)) next = next.nextElementSibling;
        if (next && visible(next) && !out.includes(next)) out.push(next);
        continue;
      }
      if (el.tagName === 'LABEL') {
        if (el.control) push(el.control);
        const inner = el.querySelector('input,select,textarea,button'); if (inner) push(inner);
      }
      const cell = el.closest('td,th');
      if (cell) {
        let next = cell.nextElementSibling;
        while (next && !next.querySelector('input,select,textarea,button')) next = next.nextElementSibling;
        if (next) push(next.querySelector('input,select,textarea,button'));
        const inCell = [...cell.querySelectorAll('input,select,textarea,button')]; if (inCell.length) push(inCell[0]);
      }
      // next control in document order after the label
      let n = el;
      for (let hops = 0; hops < 6 && n; hops++) {
        const sib = n.nextElementSibling;
        if (sib) { const c = sib.matches('input,select,textarea,button') ? sib : sib.querySelector('input,select,textarea,button'); if (c) { push(c); break; } n = sib; }
        else n = n.parentElement;
      }
    }
    return out;
  }
  function findByText(text, tag, exact) {
    const want = norm(text);
    const wantL = want.toLowerCase();
    const cands = [];
    const sel = tag ? tag : 'a,button,input,td,th,span,div,font,b,strong,li,label,option,p,h1,h2,h3,h4,h5,h6,legend,caption,dt,dd,center';
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[data-cua-marks]')) continue;
      let t;
      if (el.tagName === 'INPUT') t = norm(el.value); else t = ownText(el) || norm(el.textContent);
      if (!t) continue;
      const ok = exact === false ? t.toLowerCase().includes(wantL) : t === want || t.toLowerCase() === wantL;
      if (ok && visible(el)) cands.push(el);
    }
    // prefer the deepest matching elements
    return cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
  }
  function findTableCell(spec) {
    const wantHeaders = spec.headers.map((h) => norm(h).toLowerCase());
    const out = [];
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.rows];
      if (rows.length < 2) continue;
      const hri = headerRowIndex(table);
      const headers = [...rows[hri].cells].map((c) => norm(c.textContent).toLowerCase());
      if (!wantHeaders.every((h) => headers.includes(h))) continue;
      const colIdx = headers.indexOf(norm(spec.column).toLowerCase());
      if (colIdx < 0) continue;
      const dataRows = rows.slice(hri + 1);
      let matches = dataRows;
      if (spec.row) {
        const ri = headers.indexOf(norm(spec.row.column).toLowerCase());
        if (ri < 0) continue;
        const eq = norm(spec.row.equals).toLowerCase();
        matches = dataRows.filter((r) => r.cells[ri] && norm(r.cells[ri].textContent).toLowerCase() === eq);
      } else if (typeof spec.rowIndex === 'number') {
        matches = dataRows[spec.rowIndex] ? [dataRows[spec.rowIndex]] : [];
      }
      for (const r of matches) {
        const cell = r.cells[colIdx];
        if (!cell) continue;
        let target = cell;
        if (spec.inner === 'link') target = cell.querySelector('a[href]');
        else if (spec.inner === 'control') target = cell.querySelector('input:not([type=hidden]),select,textarea,button');
        if (target && visible(target)) out.push(target);
      }
    }
    return out;
  }
  function mark(entries) {
    unmark();
    const host = document.body || document.documentElement;
    if (!host) return;
    const c = document.createElement('div');
    c.setAttribute('data-cua-marks', '1');
    c.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    const sx = window.scrollX || 0, sy = window.scrollY || 0;
    for (const e of entries) {
      const b = e.localBbox;
      const box = document.createElement('div');
      const color = e.interactive ? '#d6336c' : '#1c7ed6';
      box.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid ' + color + ';left:' + (b.x + sx) + 'px;top:' + (b.y + sy) + 'px;width:' + b.w + 'px;height:' + b.h + 'px;pointer-events:none;';
      const lab = document.createElement('span');
      lab.textContent = e.ref;
      lab.style.cssText = 'position:absolute;left:-2px;top:-14px;background:' + color + ';color:#fff;font:bold 10px/12px Arial,sans-serif;padding:0 3px;border-radius:2px;white-space:nowrap;';
      box.appendChild(lab);
      c.appendChild(box);
    }
    host.appendChild(c);
  }
  function unmark() { for (const el of document.querySelectorAll('[data-cua-marks]')) el.remove(); }
  function visibleText() { return document.body ? document.body.innerText || '' : ''; }
  function signature() {
    const txt = visibleText();
    return location.href + '|' + txt.length + '|' + document.querySelectorAll('*').length + '|' + txt.slice(0, 200);
  }
  window.__cua = { v: ${INDEXER_VERSION}, index, elementAt, register, describeAt, findByLabel, findByText, findTableCell, mark, unmark, visibleText, signature };
})();
`;

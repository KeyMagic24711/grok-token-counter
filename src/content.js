// Isolated-world content script: renders a slim strip attached below grok.com's
// chat composer (fallback: fixed bottom strip), and
// receives usage data from bridge.js (MAIN world) via window.postMessage.
(() => {
  'use strict';
  const IN_FRAME = window.top !== window;
  if (IN_FRAME && window.name !== 'gtc-usage-frame') return;
  if (document.getElementById('gtc-strip')) return;
  const VI = /^vi\b/i.test(navigator.language || '');
  const T = VI ? {
    grok: 'Grok tuần', bot: 'Grok Bot tuần', resetsIn: 'reset sau', resetAt: 'Reset lúc', upd: 'cập nhật lúc', openUsage: 'mở Usage để cập nhật',
    nodata: 'chưa có dữ liệu', refresh: 'Làm mới (mở Usage ngầm nếu cần)', src1: 'Nguồn: API GetGrokCreditsConfig', src2: 'Nguồn: Cài đặt > Usage', src3: 'Nguồn: WebSocket bot.usage', cached: ' (bộ nhớ đệm)'
  } : {
    grok: 'Grok weekly', bot: 'Grok Bot weekly', resetsIn: 'resets in', resetAt: 'Resets at', upd: 'updated at', openUsage: 'open Usage to update',
    nodata: 'no data yet', refresh: 'Refresh (opens Usage in background if needed)', src1: 'Source: GetGrokCreditsConfig API', src2: 'Source: Settings > Usage', src3: 'Source: WebSocket bot.usage', cached: ' (cached)'
  };
  const LOCALE = VI ? 'vi-VN' : undefined;
  // Product ids / names treated as "Grok Bot". Unknown until confirmed on a live
  // account; override: localStorage.setItem("gtcGrokBotId", N) on grok.com.
  let BOT_IDS = [];
  try { const v = parseInt(localStorage.getItem('gtcGrokBotId'), 10); if (Number.isFinite(v)) BOT_IDS = [v]; } catch (e) {}
  const BOT_NAME_RE = /grok\s*bot|agent|assistant/i;
  let botCache = null; try { botCache = JSON.parse(localStorage.getItem('gtcBotUsage') || 'null'); if (botCache) botCache.cached = true; } catch (e) {}
  const state = { bot: botCache, rates: {}, credits: null, unauth: false, drift: false };

  const strip = document.createElement('div');
  strip.id = 'gtc-strip';
  strip.className = 'gtc-strip';
  const store = chrome && chrome.storage && chrome.storage.local;
  if (store) store.get(['gtcGrokBotId'], v => { if (Number.isFinite(v.gtcGrokBotId)) BOT_IDS = [v.gtcGrokBotId]; render(); });
  strip.addEventListener('click', e => { if (e.target.closest('[data-a="usage"]')) { openUsageRefresh(); return; } if (e.target.closest('[data-a="refresh"]')) { lastPoll = 0; requestPoll(); if ((!dom || Date.now() - dom.at > 5 * 60 * 1000) && !(state.bot && Date.now() - state.bot.at < 5 * 60 * 1000)) openUsageRefresh(); } });


  // ---- DOM fallback: read Settings > Usage dialog (Weekly ... Limit blocks) ----
  const DOM_KEY = 'gtcDomUsage', STALE_MS = 30 * 60 * 1000;
  let dom = null;
  try { dom = JSON.parse(localStorage.getItem(DOM_KEY) || 'null'); } catch (e) {}
  if (store) store.get([DOM_KEY], v => { if (v[DOM_KEY] && (!dom || v[DOM_KEY].at > dom.at)) { dom = v[DOM_KEY]; render(); } });
  // Reset date parser: English + Vietnamese + generic d/m/y HH:MM.
  function mkDate(y, mo, d, h, mi, ap) {
    h = +h; mi = +mi;
    if (ap) { const pm = /^(p|ch)/i.test(ap); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    let yy = y ? +y : new Date().getFullYear();
    let t = new Date(yy, +mo - 1, +d, h, mi).getTime();
    if (!y && t < Date.now() - 864e5) t = new Date(yy + 1, +mo - 1, +d, h, mi).getTime();
    return Number.isFinite(t) && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? t : null;
  }
  const AP = '(?:\\s*(SA|CH|AM|PM|a\\.m\\.|p\\.m\\.)(?![A-Za-zÀ-ỹ]))?';
  function parseReset(txt) {
    if (!txt) return null;
    // focus on text after a reset keyword when present
    const k = txt.search(/Resets?|Đặt lại|Làm mới|Reset|Khôi phục/i);
    const t = k >= 0 ? txt.slice(k) : txt;
    let m;
    // English: "October 19, 2026 at 11:34 AM" / "Oct 19 11:25 AM"
    m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\s*(?:at|,)?\s*(\d{1,2}):(\d{2})\s*([AP]\.?M\.?)?/i);
    if (m) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[1].slice(0, 3).toLowerCase()); if (mo >= 0 && mo % 3 === 0) { const r = mkDate(m[3], mo / 3 + 1, m[2], m[4], m[5], m[6]); if (r) return r; } }
    // Vietnamese: "19 thg 10, 2026 lúc 11:34" / "19 tháng 10 năm 2026 11:34"
    m = t.match(new RegExp('(\\d{1,2})\\s*(?:thg|tháng)\\s*(\\d{1,2})(?:,?\\s*(?:năm\\s*)?(\\d{4}))?\\D{0,10}?(\\d{1,2}):(\\d{2})' + AP, 'i'));
    if (m) { const r = mkDate(m[3], m[2], m[1], m[4], m[5], m[6]); if (r) return r; }
    // "11:34 19 thg 10, 2026" (time first)
    m = t.match(new RegExp('(\\d{1,2}):(\\d{2})' + AP + '\\D{0,10}?(\\d{1,2})\\s*(?:thg|tháng)\\s*(\\d{1,2})(?:,?\\s*(?:năm\\s*)?(\\d{4}))?', 'i'));
    if (m) { const r = mkDate(m[6], m[5], m[4], m[1], m[2], m[3]); if (r) return r; }
    // "11:34 19/10/2026"
    m = t.match(new RegExp('(\\d{1,2}):(\\d{2})' + AP + '\\D{0,10}?(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{4}))?'));
    if (m) { const r = mkDate(m[6], m[5], m[4], m[1], m[2], m[3]); if (r) return r; }
    // "19/10/2026 11:34"
    m = t.match(new RegExp('(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{4}))?\\D{0,10}?(\\d{1,2}):(\\d{2})' + AP));
    if (m) { const r = mkDate(m[3], m[2], m[1], m[4], m[5], m[6]); if (r) return r; }
    // ISO "YYYY-MM-DD HH:MM"
    m = t.match(/(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
    if (m) return mkDate(m[1], m[2], m[3], m[4], m[5]);
    if (k >= 0 && t !== txt) return parseReset(txt.replace(/Resets?|Đặt lại|Làm mới|Khôi phục/gi, ' '));
    return null;
  }
  // Language-independent Usage reader: find usage bars, group into cards,
  // classify by aria-label / heading (EN/VI) / bar shape / order.
  function barHosts() {
    const out = new Set();
    document.querySelectorAll('[role="progressbar"]').forEach(e => { if (!strip.contains(e)) out.add(e); });
    document.querySelectorAll('div[style*="width"]').forEach(seg => {
      if (strip.contains(seg) || !/width:\s*[\d.]+%/.test(seg.getAttribute('style') || '')) return;
      const host = seg.parentElement; if (!host || out.has(host)) return;
      const kids = Array.from(host.children);
      if (kids.length >= 2 && kids.every(c => /width:\s*[\d.]+%/.test(c.getAttribute('style') || '') || /flex-1/.test(c.className || '') || c.getAttribute('aria-hidden') === 'true')) {
        if (!host.closest('[role="progressbar"]')) out.add(host);
      }
    });
    return Array.from(out);
  }
  function cardOf(bar) {
    let el = bar;
    for (let i = 0; el.parentElement && i < 8; i++) {
      el = el.parentElement;
      if (el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
        if (barHosts().filter(b => el.contains(b)).length > 1) return bar.parentElement; // too wide
        return el;
      }
    }
    return bar.parentElement;
  }
  function pctOf(bar, card) {
    let sum = 0, n = 0;
    for (const c of bar.children) { const m = (c.getAttribute('style') || '').match(/width:\s*([\d.]+)%/); if (m) { sum += parseFloat(m[1]); n++; } }
    if (n && sum <= 100) return { pct: sum, src: 'width', segs: n };
    const v = bar.getAttribute('aria-valuenow'); if (v != null && isFinite(+v)) return { pct: +v, src: 'aria-valuenow', segs: 0 };
    const nf = card.querySelector('number-flow-react[aria-label], number-flow[aria-label], [role="img"][aria-label*="%"]');
    const m = nf && (nf.getAttribute('aria-label') || '').match(/([\d.,]+)\s*%/);
    if (m) return { pct: parseFloat(m[1].replace(',', '.')), src: 'number-flow', segs: 0 };
    return null;
  }
  function readUsageCards() {
    const cards = [];
    for (const bar of barHosts()) {
      const card = cardOf(bar), p = pctOf(bar, card); if (!p) continue;
      const head = (card.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]') || {}).textContent || '';
      const label = bar.getAttribute('aria-label') || '';
      const txt = card.textContent.replace(/\s+/g, ' ');
      cards.push({ bar, card, ...p, head, label, isPB: bar.getAttribute('role') === 'progressbar', resetAt: parseReset(txt),
        weekly: /weekly|hàng tuần|mỗi tuần|tuần/i.test(head + ' ' + txt) });
    }
    cards.sort((a, b) => (a.bar.compareDocumentPosition(b.bar) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    const isBot = c => /grok\s*bot/i.test(c.label) || /grok\s*bot/i.test(c.head);
    // Grok weekly = the weekly card that is not Grok Bot (plan name in the heading varies by plan).
    let bot = cards.find(isBot);
    const others = cards.filter(c => c !== bot);
    let sg = others.find(c => c.weekly && !c.isPB) || others.find(c => c.weekly) || others.find(c => !c.isPB) || null;
    if (!bot) bot = cards.find(c => c !== sg && c.isPB) || cards.filter(c => c !== sg)[0] || null; // second weekly card
    const pack = c => c ? { pct: c.pct, resetAt: c.resetAt, src: c.src } : null;
    return { bot: pack(bot), sg: pack(sg), n: cards.length };
  }
  function scrapeUsage() {
    try {
      const r = readUsageCards(); const bot = r.bot, sg = r.sg;
      if (!bot && !sg) return false;
      const next = { at: Date.now(), grokBot: bot || (dom && dom.grokBot) || null, grokWeekly: sg || (dom && (dom.grokWeekly || dom.superGrok)) || null };
      const changed = !dom || JSON.stringify([next.grokBot, next.grokWeekly]) !== JSON.stringify([dom.grokBot, dom.grokWeekly]) || Date.now() - dom.at > 60000;
      if (changed) {
        dom = next;
        try { localStorage.setItem(DOM_KEY, JSON.stringify(dom)); } catch (e) {}
        if (store) store.set({ [DOM_KEY]: dom });
        render();
      }
      return true;
    } catch (e) { return false; }
  }
  // Refresh helpers. 1) hidden same-origin iframe of grok.com/?_s=usage (works only
  // if grok.com allows framing itself); 2) small popup, only on user click.
  const AUTO_POPUP = window.name === 'gtc-usage-refresh';
  if (AUTO_POPUP || IN_FRAME) { const t0 = Date.now(); const iv = setInterval(() => { if (scrapeUsage() || Date.now() - t0 > 15000) { clearInterval(iv); if (AUTO_POPUP) setTimeout(() => window.close(), 800); } }, 700); }
  const LAST_TRY_KEY = 'gtcUsageLastTry', MIN_GAP = 30 * 60 * 1000;
  function hiddenRefresh(force) {
    if (IN_FRAME) return Promise.resolve(false);
    let last = 0; try { last = +localStorage.getItem(LAST_TRY_KEY) || 0; } catch (e) {}
    if (!force && Date.now() - last < MIN_GAP) return Promise.resolve(false);
    try { localStorage.setItem(LAST_TRY_KEY, String(Date.now())); } catch (e) {}
    const before = dom ? dom.at : 0;
    return new Promise(resolve => {
      const f = document.createElement('iframe');
      f.name = 'gtc-usage-frame'; f.src = 'https://grok.com/?_s=usage'; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;opacity:0;pointer-events:none;border:0';
      document.body.appendChild(f);
      const t0 = Date.now();
      const iv = setInterval(() => {
        let cur = null; try { cur = JSON.parse(localStorage.getItem(DOM_KEY) || 'null'); } catch (e) {}
        if (cur && cur.at > before) { dom = cur; render(); done(true); }
        else if (Date.now() - t0 > 20000) done(false);
      }, 1000);
      function done(ok) { clearInterval(iv); f.remove(); resolve(ok); }
    });
  }
  function openUsageRefresh() {
    hiddenRefresh(true).then(ok => { if (!ok) window.open('https://grok.com/?_s=usage', 'gtc-usage-refresh', 'width=520,height=640'); });
  }
  addEventListener('storage', e => { if (e.key === DOM_KEY && e.newValue) { try { dom = JSON.parse(e.newValue); render(); } catch (x) {} } });
  if (IN_FRAME) return; // scrape-only mode inside hidden iframe

  // ---- anchoring (modelled on Claude Token Counter ui.js findComposerCard) ----
  const INPUT_SEL = 'form textarea, form [contenteditable="true"], .query-bar textarea, .query-bar [contenteditable="true"], textarea[aria-label], div[contenteditable="true"].ProseMirror, textarea';
  function findInput() {
    for (const el of document.querySelectorAll(INPUT_SEL)) {
      if (strip.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 120 && r.height > 8) return el;
    }
    return null;
  }
  function findComposerCard(input) {
    let el = input && input.parentElement;
    for (let hops = 0; el && el !== document.body && hops < 10; hops++, el = el.parentElement) {
      if (el.matches('.query-bar, [class*="query-bar"]')) return el;
      const st = getComputedStyle(el);
      if (parseFloat(st.borderRadius) < 8) continue;
      const bg = st.backgroundColor, bd = parseFloat(st.borderTopWidth);
      if ((!bg || bg === 'transparent' || bg.replace(/\s/g, '') === 'rgba(0,0,0,0)') && !(bd > 0)) continue;
      if (el.getBoundingClientRect().width < 200) continue;
      return el;
    }
    return input ? (input.closest('form') || input.parentElement) : null;
  }
  let ro = null, roCard = null;
  function alignTo(card) {
    const cr = card.getBoundingClientRect(), pr = strip.parentElement.getBoundingClientRect();
    const w = Math.round(cr.width), ml = Math.round(cr.left - pr.left);
    if (strip.style.width !== w + 'px') strip.style.width = w + 'px';
    if (strip.style.marginLeft !== ml + 'px') strip.style.marginLeft = ml + 'px';
    const rad = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 12;
    strip.style.paddingLeft = strip.style.paddingRight = Math.max(12, Math.min(24, rad * 0.75)) + 'px';
    if (roCard !== card && 'ResizeObserver' in window) {
      if (ro) ro.disconnect(); roCard = card;
      ro = new ResizeObserver(() => schedulePlace()); ro.observe(card);
    }
  }
  // Inside the composer frame, as its last child, below the controls row.
  // If grok.com's controls are absolutely positioned at the bottom (so they would
  // overlap a normal-flow row), lift those positioned containers by our height.
  const lifted = new Map(); // element -> original inline bottom
  function unlift() { for (const [el, o] of lifted) el.style[o.prop] = o.val; lifted.clear(); }
  function overlaps(a, b) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }
  function liftOverlaps(card) {
    const sr = strip.getBoundingClientRect(); if (!sr.height) return;
    const ctrls = Array.from(card.querySelectorAll('button, [role="button"], select, input:not([type="hidden"])')).filter(el => !strip.contains(el));
    for (const el of ctrls) {
      const r = el.getBoundingClientRect(); if (!r.width || !overlaps(r, sr)) continue;
      // nearest positioned (absolute/fixed) ancestor inside the card
      let pos = el;
      while (pos && pos !== card && !/absolute|fixed/.test(getComputedStyle(pos).position)) pos = pos.parentElement;
      if (!pos || pos === card || lifted.has(pos)) continue;
      const cs = getComputedStyle(pos), curB = parseFloat(cs.bottom);
      if (Number.isFinite(curB)) { lifted.set(pos, { prop: 'bottom', val: pos.style.bottom }); pos.style.bottom = (curB + sr.height + 2) + 'px'; }
      else { const t = parseFloat(cs.top) || 0; lifted.set(pos, { prop: 'top', val: pos.style.top }); pos.style.top = (t - sr.height - 2) + 'px'; }
    }
  }
  let padCard = null, padOrig = null, posOrig = null;
  function unpad() {
    if (padCard) { padCard.style.paddingBottom = padOrig; padCard.style.position = posOrig; padCard = null; }
  }
  function place() {
    const card = findComposerCard(findInput());
    if (card) {
      strip.classList.remove('gtc-fixed'); strip.classList.add('gtc-inside');
      strip.style.width = ''; strip.style.marginLeft = ''; strip.style.flex = ''; strip.style.order = '';
      const cs = getComputedStyle(card);
      const rad = parseFloat(cs.borderTopLeftRadius) || 12;
      strip.style.paddingLeft = strip.style.paddingRight = Math.max(12, Math.min(24, rad * 0.75)) + 'px';
      if (padCard !== card) {
        unlift(); unpad();
        padCard = card; padOrig = card.style.paddingBottom; posOrig = card.style.position;
        if (cs.position === 'static') card.style.position = 'relative';
      }
      if (strip.parentElement !== card) card.appendChild(strip);
      // reserve room at the bottom inner edge: original padding + our height
      const h = strip.offsetHeight || 22;
      card.style.paddingBottom = '';
      if (padOrig) card.style.paddingBottom = padOrig;
      const basePad = parseFloat(getComputedStyle(card).paddingBottom) || 0;
      const want = (basePad + h) + 'px';
      if (card.style.paddingBottom !== want) card.style.paddingBottom = want;
      // bottom-anchored absolute controls ignore padding: lift them above the row
      requestAnimationFrame(() => liftOverlaps(card));
      if (roCard !== card && 'ResizeObserver' in window) { if (ro) ro.disconnect(); roCard = card; ro = new ResizeObserver(() => schedulePlace()); ro.observe(card); }
    } else {
      unlift(); unpad(); strip.classList.remove('gtc-inside');
      strip.classList.add('gtc-fixed'); strip.style.width = ''; strip.style.marginLeft = ''; strip.style.paddingLeft = strip.style.paddingRight = '';
      if (strip.parentElement !== document.body) document.body.appendChild(strip);
    }
  }
  let placeTimer = null;
  const schedulePlace = () => { if (!placeTimer) placeTimer = setTimeout(() => { placeTimer = null; place(); }, 250); };

  // ---- theme ----
  function applyTheme() {
    const m = (getComputedStyle(document.body).backgroundColor || '').match(/[\d.]+/g);
    const light = m && m.length >= 3 && (m[3] === undefined || +m[3] > 0) && (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) > 160;
    strip.classList.toggle('gtc-light', !!light); strip.classList.toggle('gtc-dark', !light);
  }

  new MutationObserver(muts => { if (muts.some(m => !strip.contains(m.target))) { schedulePlace(); scheduleScrape(); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  addEventListener('resize', schedulePlace);
  let scrapeTimer = null;
  const scheduleScrape = () => { if (!scrapeTimer) scrapeTimer = setTimeout(() => { scrapeTimer = null; scrapeUsage(); }, 500); };

  // ---- bridge ----
  addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.source !== 'GTC') return;
    const { kind, payload } = ev.data;
    if (kind === 'rate' && payload) { state.rates[payload.model] = payload; state.unauth = state.drift = false; }
    else if (kind === 'credits' && payload) { state.credits = payload; state.creditsAt = Date.now(); state.unauth = state.drift = false;
}
    else if (kind === 'botusage' && payload) { state.bot = payload; try { localStorage.setItem('gtcBotUsage', JSON.stringify(payload)); } catch (e) {} if (store) store.set({ gtcBotUsage: payload }); }
    else if (kind === 'unauthorized') state.unauth = true;
    else if (kind === 'drift') state.drift = true;
    else if (kind === 'conversation-activity') setTimeout(requestPoll, 3000);
    else if (kind === 'ready') requestPoll();
    render();
  });
  let lastPoll = 0;
  function requestPoll() {
    if (Date.now() - lastPoll < 15000) return; lastPoll = Date.now();
    window.postMessage({ source: 'GTC-CS', kind: 'poll', models: ['grok-3'] }, location.origin);
  }

  // ---- render ----
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = n => n.toLocaleString(LOCALE);
  function fmtDur(ms) {
    if (!(ms > 0)) return '0m'; const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }
  const fmtDate = t => new Date(t).toLocaleString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  // ---- usage row: markup, bar, marker and paint logic adapted from
  // Claude Token Counter src/content/ui.js (makeBar/paintWindow/retimeReset),
  // MIT (c) kr1shnasomani. Built once; only text/width/marker updated after.
  const WEEK = 7 * 864e5;
  function formatResetCountdown(ts) {
    const diff = ts - Date.now(); if (diff <= 0) return '0s';
    const sec = Math.floor(diff / 1000); if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60); if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60), d = Math.floor(h / 24);
    return d ? `${d}d ${h % 24}h` : `${h}h ${min % 60}m`;
  }
  function makeBar() {
    const bar = document.createElement('div'); bar.className = 'gtc-bar';
    const fill = document.createElement('div'); fill.className = 'gtc-bar__fill';
    const marker = document.createElement('div'); marker.className = 'gtc-bar__marker gtc-hidden';
    bar.append(fill, marker); return { bar, fill, marker };
  }
  const ui = (() => {
    const mk = (cls, tag = 'span') => { const e = document.createElement(tag); e.className = cls; return e; };
    const gText = mk('gtc-usageText'), bText = mk('gtc-usageText');
    const g = makeBar(), b = makeBar();
    const gGroup = mk('gtc-usageGroup', 'div'); gGroup.append(gText, g.bar);
    const bGroup = mk('gtc-usageGroup gtc-usageGroup--weekly', 'div'); bGroup.append(b.bar, bText);
    const btn = mk('gtc-refreshBtn', 'button'); btn.dataset.a = 'refresh'; btn.setAttribute('aria-label', T.refresh); btn.title = T.refresh;
    btn.innerHTML = '<svg class="gtc-refreshIcon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
    strip.classList.add('gtc-usageRow');
    strip.append(gGroup, bGroup, btn);
    return { gText, bText, g, b, gGroup, bGroup };
  })();
  function paintWindow(pct, resetMs, label, span, bar, tip, startMs) {
    span.title = bar.bar.title = tip || '';
    if (typeof pct !== 'number' || !Number.isFinite(pct)) { bar.fill.style.width = '0%'; bar.marker.classList.add('gtc-hidden'); return; }
    const p = Math.round(pct * 10) / 10;
    span.dataset.label = `${label}: ${Math.round(p)}%`; span.dataset.short = `${label.replace(/\s*(weekly|tuần)$/i, '')}: ${Math.round(p)}%`; span.dataset.reset = resetMs || '';
    retime(span);
    const w = Math.max(0, Math.min(100, pct));
    bar.fill.style.width = `${w}%`;
    bar.fill.classList.toggle('gtc-caution', w >= 75 && w < 90);
    bar.fill.classList.toggle('gtc-warn', w >= 90);
    bar.fill.classList.toggle('gtc-full', w >= 99.5);
    if (resetMs) { const span0 = startMs && resetMs > startMs ? resetMs - startMs : WEEK; bar.marker.style.left = `${Math.max(0, Math.min(100, (1 - (resetMs - Date.now()) / span0) * 100))}%`; bar.marker.classList.remove('gtc-hidden'); }
    else bar.marker.classList.add('gtc-hidden');
  }
  function retime(span) {
    if (!span.dataset.label) return;
    const r = +span.dataset.reset;
    const compact = strip.clientWidth > 0 && strip.clientWidth < 640;
    strip.classList.toggle('gtc-compact', compact);
    const base = compact ? span.dataset.short : span.dataset.label;
    const t = r ? (compact ? `${base} · ${formatResetCountdown(r)}` : `${base} (${T.resetsIn} ${formatResetCountdown(r)})`) : base;
    if (span.textContent !== t) span.textContent = t;
  }
  const planTxt = () => (state.bot && state.bot.planLabel ? ` · ${state.bot.planLabel}` : '');
  function tipFor(src, resetAt, at) {
    const l = [src];
    if (resetAt) l.push(`${T.resetAt}: ${fmtDate(resetAt)}`);
    if (at) l.push(`${T.upd}: ${new Date(at).toLocaleString(LOCALE, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`);
    return l.join('\n');
  }
  function placeholder(span, bar, text, link) {
    delete span.dataset.label; span.textContent = text; span.classList.toggle('gtc-link', !!link);
    if (link) span.dataset.a = 'usage'; else delete span.dataset.a;
    bar.fill.style.width = '0%'; bar.marker.classList.add('gtc-hidden');
  }
  function render() {
    if (IN_FRAME) return;
    applyTheme();
    const c = state.credits;
    if (c) { ui.gText.classList.remove('gtc-link'); paintWindow(c.used, c.resetAt, T.grok, ui.gText, ui.g, tipFor(T.src1 + planTxt(), c.resetAt, state.creditsAt)); }
    else if (dom && (dom.grokWeekly || dom.superGrok)) { const gw = dom.grokWeekly || dom.superGrok; ui.gText.classList.remove('gtc-link'); paintWindow(gw.pct, gw.resetAt, T.grok, ui.gText, ui.g, tipFor(T.src2 + planTxt(), gw.resetAt, dom.at)); }
    else placeholder(ui.gText, ui.g, `${T.grok}: ${T.nodata}`, false);
    const sb = state.bot, botLive = sb && (!dom || !dom.grokBot || sb.at >= dom.at - 60000);
    if (botLive) { ui.bText.classList.remove('gtc-link'); delete ui.bText.dataset.a; paintWindow(sb.pct, sb.resetAt, T.bot, ui.bText, ui.b, tipFor(T.src3 + (sb.cached ? T.cached : ''), sb.resetAt, sb.at), sb.startMs); }
    else if (dom && dom.grokBot) { ui.bText.classList.remove('gtc-link'); delete ui.bText.dataset.a; paintWindow(dom.grokBot.pct, dom.grokBot.resetAt, T.bot, ui.bText, ui.b, tipFor(T.src2, dom.grokBot.resetAt, dom.at)); }
    else placeholder(ui.bText, ui.b, `${T.bot}: ${T.openUsage}`, true);
  }
  // per-second tick: only rewrite countdown text (cheap), full paint every 30s
  setInterval(() => { retime(ui.gText); retime(ui.bText); }, 1000);
  setInterval(render, 30000);
  setInterval(requestPoll, 5 * 60 * 1000);
  place(); render(); scrapeUsage(); setTimeout(requestPoll, 1500);
  const staleCheck = () => { if (document.visibilityState === 'visible' && (!dom || Date.now() - dom.at > STALE_MS) && !(state.bot && Date.now() - state.bot.at < STALE_MS)) hiddenRefresh(false); };
  setTimeout(staleCheck, 8000); setInterval(staleCheck, 5 * 60 * 1000);
})();

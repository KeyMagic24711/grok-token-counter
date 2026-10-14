// Conversation token badge for grok.com, modelled on Claude Token Counter's
// header chip (cc-headerItem; MIT (c) kr1shnasomani). Counts locally with the
// bundled o200k_base tokenizer (gpt-tokenizer, MIT) - an estimate for Grok.
(() => {
  'use strict';
  if (window.top !== window || document.getElementById('gtc-badge')) return;
  const LOCALE = 'en-US';
  const T =
      { unit: 'tokens', tip: 'Estimated tokens of the whole open conversation (o200k tokenizer, counted offline). Grok\'s real tokenizer differs, so treat it as approximate.', src: { api: 'Source: grok.com conversation data', dom: 'Source: visible page content' } };

  const pill = document.createElement('span');
  pill.id = 'gtc-badge'; pill.className = 'gtc-badge gtc-hidden'; pill.setAttribute('role', 'status');
  const api = new Map(); // convId -> { tokens, n }
  let lastText = '', lastCount = 0, mode = null;

  const tk = () => globalThis.GPTTokenizer_o200k_base;
  const count = (t) => { try { return t ? tk().countTokens(t) : 0; } catch (e) { return 0; } };
  const convId = () => { const m = location.pathname.match(/\/(?:c|chat|conversation)\/([0-9a-zA-Z-]{8,})/); return m ? m[1] : null; };

  // ---- DOM text of the conversation (generic: normal chat + Grok Bot chat) ----
  const BUBBLE = '.message-bubble, [class*="message-bubble"], [data-testid*="message" i], [id^="response-"], .response-content-markdown, [class*="prose"], [class*="markdown"]';
  const SKIP = '#gtc-strip,#gtc-badge,form,textarea,[contenteditable="true"],nav,aside,header,button';
  function composer() { const s = document.getElementById('gtc-strip'); return (s && s.parentElement) || (document.querySelector('form textarea, [contenteditable="true"]') || {}).parentElement || null; }
  function bubbles() {
    let nodes = Array.from(document.querySelectorAll(BUBBLE)).filter(n => !n.closest(SKIP) && (n.textContent || '').trim());
    return nodes.filter(n => !nodes.some(o => o !== n && o.contains(n)));
  }
  function scrollArea() {
    const comp = composer(); let best = null, bestH = 0;
    for (const el of document.querySelectorAll('main, main *, [role="main"], [role="main"] *, div')) {
      if (el.clientHeight < 200 || el.scrollHeight <= bestH) continue;
      if (el.closest('nav,aside')) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect(); if (r.width < 300) continue;
      if (el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
    }
    return best;
  }
  function domText() {
    const bs = bubbles();
    if (bs.length) return { text: bs.map(n => n.innerText || n.textContent || '').join('\n').trim(), n: bs.length };
    const area = scrollArea(); if (!area) return { text: '', n: 0 };
    const c = area.cloneNode(true);
    const comp = composer(); if (comp && area.contains(comp)) { const idx = Array.from(area.querySelectorAll('*')).indexOf(comp); const cc = idx >= 0 && c.querySelectorAll('*')[idx]; if (cc) cc.remove(); }
    c.querySelectorAll(SKIP + ',svg,style,script').forEach(x => x.remove());
    return { text: (c.innerText || c.textContent || '').trim(), n: 0, fallback: true };
  }

  // ---- placement (localStorage gtcBadgePos: right | left | strip) ----
  const posMode = () => { try { const v = localStorage.getItem('gtcBadgePos'); return /^(left|strip|right)$/.test(v) ? v : 'strip'; } catch (e) { return 'strip'; } };
  function mainBounds() {
    let left = 0;
    for (const el of document.querySelectorAll('nav, aside, [class*="sidebar" i]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > innerHeight * 0.5 && r.left <= 2 && r.right < innerWidth * 0.45) left = Math.max(left, r.right);
    }
    const comp = composer();
    let right = innerWidth;
    if (comp) { // composer's column bounds: climb to widest ancestor that does not include the sidebar
      let el = comp;
      while (el.parentElement && el.parentElement !== document.body) { const r = el.parentElement.getBoundingClientRect(); if (r.left < left - 1) break; el = el.parentElement; }
      const r = el.getBoundingClientRect(); right = Math.min(innerWidth, r.right || innerWidth); left = Math.max(left, r.left);
    }
    return { left, right };
  }
  function iconCluster(mb) {
    const btns = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]')).filter(b => {
      if (pill.contains(b) || b.closest('#gtc-strip,form')) return false;
      const r = b.getBoundingClientRect();
      return r.width && r.width <= 64 && r.height <= 52 && r.top >= 0 && r.top < 110 && r.right > innerWidth - 200 && r.left > Math.max(mb.left, 172);
    }).map(b => ({ b, r: b.getBoundingClientRect() })).sort((x, y) => y.r.right - x.r.right);
    if (!btns.length) return null;
    const group = [btns[0]];
    for (let i = 1; i < btns.length; i++) { if (group[group.length - 1].r.left - btns[i].r.right < 28 && Math.abs(btns[i].r.top - btns[0].r.top) < 16) group.push(btns[i]); else break; }
    const left = Math.min(...group.map(g => g.r.left)), top = Math.min(...group.map(g => g.r.top)), bottom = Math.max(...group.map(g => g.r.bottom));
    return { left, top, bottom };
  }
  function setFixed(css) {
    if (pill.parentElement !== document.body) document.body.appendChild(pill);
    pill.className = pill.className.replace(/\s*gtc-badge--(fixed|strip)/g, '') + ' gtc-badge--fixed';
    Object.assign(pill.style, { left: 'auto', right: 'auto', top: '' }, css);
  }
  function place() {
    const m = posMode();
    if (m === 'strip') {
      const strip = document.getElementById('gtc-strip');
      if (strip) {
        pill.className = pill.className.replace(/\s*gtc-badge--(fixed|strip)/g, '') + ' gtc-badge--strip';
        Object.assign(pill.style, { left: '', right: '', top: '' });
        if (strip.firstElementChild !== pill) strip.insertBefore(pill, strip.firstElementChild);
        return;
      }
      pill.classList.add('gtc-hidden'); return; // no strip yet: never float by default
    }
    const mb = mainBounds();
    if (m === 'left') { setFixed({ left: Math.round(mb.left + 16) + 'px', top: '14px' }); return; }
    const c = iconCluster(mb);
    const ph = pill.offsetHeight || 22;
    if (c) setFixed({ right: Math.round(innerWidth - c.left + 8) + 'px', top: Math.round(c.top + (c.bottom - c.top - ph) / 2) + 'px' });
    else setFixed({ right: '90px', top: '68px' });
  }

  // ---- update ----
  function update() {
    const d = domText();
    const home = !d.n && (location.pathname === '/' || !d.text || d.text.length < 40);
    if (home) { pill.classList.add('gtc-hidden'); return; }
    if (d.text !== lastText) { lastText = d.text; lastCount = count(d.text); }
    const id = convId(), a = id && api.get(id);
    const n = Math.max(lastCount, a ? a.tokens : 0);
    const src = a && a.tokens >= lastCount ? T.src.api : T.src.dom;
    const strip = posMode() === 'strip';
    const label = `${n.toLocaleString(LOCALE)} ${T.unit}${strip ? ' ·' : ''}`;
    if (pill.textContent !== label) pill.textContent = label;
    pill.title = `${T.tip}\n${src}`;
    pill.classList.toggle('gtc-hidden', n === 0);
    place();
    applyTheme();
  }
  function applyTheme() {
    const m = (getComputedStyle(document.body).backgroundColor || '').match(/[\d.]+/g);
    const light = !m || (m[3] !== undefined && +m[3] === 0) || (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) > 160;
    pill.classList.toggle('gtc-badge--dark', !light);
  }
  let timer = null;
  const schedule = (ms = 800) => { clearTimeout(timer); timer = setTimeout(update, ms); };

  addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.source !== 'GTC') return;
    if (ev.data.kind === 'convdata' && ev.data.payload) {
      const p = ev.data.payload;
      const text = p.messages.map(m => m.text).join('\n');
      api.set(p.convId, { tokens: count(text), n: p.messages.length });
      schedule(100);
    } else if (ev.data.kind === 'conversation-activity') schedule(1200);
  });
  new MutationObserver(muts => { if (muts.some(m => !pill.contains(m.target))) schedule(); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  // SPA navigation
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; lastText = ''; schedule(300); } }, 500);
  addEventListener('popstate', () => schedule(300));
  addEventListener('resize', () => schedule(150));
  addEventListener('scroll', () => { if (posMode() !== 'strip') schedule(150); }, true);
  addEventListener('storage', e => { if (e.key === 'gtcBadgePos') schedule(50); });
  schedule(500);
})();

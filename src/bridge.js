// Runs in the PAGE (MAIN) world on grok.com. Passively observes grok.com's own
// usage responses and, on request, calls the same endpoints same-origin with the
// existing session. Never sends data anywhere except window.postMessage to the
// extension's content script on the same page.
(() => {
  'use strict';
  if (window.__GTC_BRIDGE__) return;
  window.__GTC_BRIDGE__ = true;
  const TAG = 'GTC';
  const origFetch = window.fetch.bind(window);
  const RATE_RE = /\/rest\/rate-limits(\?|$)/;
  const CREDITS_PATH = '/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
  const post = (kind, payload) => { try { window.postMessage({ source: TAG, kind, payload }, location.origin); } catch (e) {} };

  // ---- minimal protobuf / grpc-web decoding (adapted from Grok Usage Watch, MIT) ----
  function decodeProto(bytes) {
    const out = {}; let at = 0;
    const varint = () => { let v = 0, s = 1; while (at < bytes.length) { const b = bytes[at++]; v += (b & 0x7f) * s; if (!(b & 0x80)) break; s *= 128; } return v; };
    while (at < bytes.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      if (!field) break;
      if (wire === 0) (out[field] = out[field] || []).push(varint());
      else if (wire === 2) { const len = varint(); if (at + len > bytes.length) break; (out[field] = out[field] || []).push(bytes.subarray(at, at + len)); at += len; }
      else if (wire === 5) { if (at + 4 > bytes.length) break; (out[field] = out[field] || []).push(new DataView(bytes.buffer, bytes.byteOffset + at, 4).getFloat32(0, true)); at += 4; }
      else if (wire === 1) at += 8; else break;
    }
    return out;
  }
  const first = (f, n) => (f && f[n] && f[n].length ? f[n][0] : undefined);
  function parseCredits(buf) {
    const bytes = new Uint8Array(buf); let at = 0, msg = null;
    while (at + 5 <= bytes.length) {
      const flag = bytes[at], len = new DataView(bytes.buffer, at + 1, 4).getUint32(0, false);
      const body = bytes.subarray(at + 5, at + 5 + len); at += 5 + len;
      if ((flag & 0x80) === 0) { msg = decodeProto(body); break; }
    }
    if (!msg) return null;
    const cfgBytes = first(msg, 1); if (!(cfgBytes instanceof Uint8Array)) return null;
    const cfg = decodeProto(cfgBytes);
    let resetAt = null; const pe = first(cfg, 5);
    if (pe instanceof Uint8Array) { const s = first(decodeProto(pe), 1); if (Number.isFinite(s) && s > 0) resetAt = s * 1000; }
    // Known ids per Grok Usage Watch; unknown ids are kept and labelled "#id".
    const LABELS = { 2: 'Grok Build', 4: 'Chat', 5: 'Imagine', 6: 'Voice' };
    const products = (cfg[7] || []).filter(e => e instanceof Uint8Array).map(e => {
      const p = decodeProto(e); const id = first(p, 1); const pc = first(p, 2);
      // look for a per-product timestamp / name in any other subfield
      let resetAt = null, name = null; const fields = {};
      for (const k of Object.keys(p)) {
        const v = p[k][0];
        if (v instanceof Uint8Array) {
          const sub = decodeProto(v); const sec = first(sub, 1);
          if (Number.isFinite(sec) && sec > 1.6e9 && sec < 4e9) { resetAt = sec * 1000; fields[k] = 'ts'; continue; }
          try { const t = new TextDecoder('utf-8', { fatal: true }).decode(v); if (/^[\x20-\x7E\u00C0-\u1EF9]{2,40}$/.test(t)) { name = name || t; fields[k] = t; continue; } } catch (x) {}
          fields[k] = 'bytes';
        } else fields[k] = v;
      }
      return { id, label: LABELS[id] || name || ('#' + id), name, percent: Number.isFinite(pc) ? pc : 0, resetAt, fields };
    });
    const usedRaw = first(cfg, 1);
    if (!Number.isFinite(usedRaw) && resetAt === null && !(cfg[7] || []).length) return null; // schema drift
    return { used: Number.isFinite(usedRaw) ? Math.max(0, Math.min(100, usedRaw)) : 0, resetAt, products };
  }
  function normRate(data, model) {
    if (!data || typeof data !== 'object') return null;
    const total = Number(data.totalQueries), remaining = Number(data.remainingQueries);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(remaining)) return null;
    const win = Number(data.windowSizeSeconds), wait = Number(data.waitTimeSeconds);
    return { model: model || 'default', total, remaining, windowSeconds: Number.isFinite(win) ? win : null,
      waitSeconds: Number.isFinite(wait) ? wait : null, capturedAt: Date.now(), raw: data };
  }
  const urlOf = (input) => { try { return typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) { return ''; } };
  const modelOf = (init) => { try { const b = init && init.body; return typeof b === 'string' ? (JSON.parse(b).modelName || null) : null; } catch (e) { return null; } };

  function inspect(url, init, res) {
    try {
      if (!res || !res.ok) { if (res && res.status === 401 && (RATE_RE.test(url) || url.includes(CREDITS_PATH))) post('unauthorized', {}); return; }
      if (RATE_RE.test(url)) {
        res.clone().json().then(d => { const r = normRate(d, modelOf(init)); post(r ? 'rate' : 'drift', r || { url: 'rate-limits' }); }).catch(() => {});
      } else if (url.includes(CREDITS_PATH)) {
        res.clone().arrayBuffer().then(b => { const c = parseCredits(b); post(c ? 'credits' : 'drift', c || { url: 'credits' }); }).catch(() => {});
      } else if (/\/rest\/app-chat\/conversations\//.test(url)) {
        post('conversation-activity', { at: Date.now() });
        const m = url.match(/\/conversations\/([0-9a-fA-F-]{16,})\/(responses|load-responses|response-node)/);
        const ct = res.headers.get('content-type') || '';
        if (m && /json/.test(ct) && !/ndjson|stream/.test(ct)) {
          res.clone().json().then(j => {
            const texts = [], seen = new WeakSet();
            const walk = (o, d) => {
              if (!o || typeof o !== 'object' || d > 6 || seen.has(o)) return; seen.add(o);
              if (Array.isArray(o)) { o.forEach(x => walk(x, d + 1)); return; }
              if (typeof o.message === 'string' && (o.sender || o.responseId || o.role)) texts.push({ id: o.responseId || null, sender: o.sender || o.role || '', text: o.message });
              for (const k of Object.keys(o)) if (k !== 'message') walk(o[k], d + 1);
            };
            walk(j, 0);
            if (texts.length) post('convdata', { convId: m[1], messages: texts, at: Date.now() });
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }


  // ---------------- OPTIONAL DEBUG (off by default) ----------------
  // Logs every grok.com request/response to the DevTools console with the
  // prefix [GTC-NET]. Console only; nothing is sent anywhere. Off by default.
  let DEBUG = false; // opt-in: localStorage.setItem('gtcDebug','1') then reload
  try { DEBUG = localStorage.getItem('gtcDebug') === '1'; } catch (e) {}
  const MAX = 2048;
  const b64 = (u8) => { let s = ''; const n = Math.min(u8.length, MAX); for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  // Strict protobuf parse: returns array of {f, w, v} or null if not valid proto.
  function strictProto(bytes, depth) {
    const out = []; let at = 0;
    const varint = () => { let v = 0, s = 1, i = 0; for (;;) { if (at >= bytes.length || i++ > 10) throw 0; const b = bytes[at++]; v += (b & 0x7f) * s; if (!(b & 0x80)) return v; s *= 128; } };
    try {
      while (at < bytes.length) {
        const key = varint(), f = Math.floor(key / 8), w = key & 7;
        if (!f || f > 536870911) return null;
        if (w === 0) out.push({ f, w, v: varint() });
        else if (w === 1) { if (at + 8 > bytes.length) return null; out.push({ f, w, v: new DataView(bytes.buffer, bytes.byteOffset + at, 8).getFloat64(0, true) }); at += 8; }
        else if (w === 5) { if (at + 4 > bytes.length) return null; const dv = new DataView(bytes.buffer, bytes.byteOffset + at, 4); out.push({ f, w, v: dv.getFloat32(0, true), u32: dv.getUint32(0, true) }); at += 4; }
        else if (w === 2) { const len = varint(); if (at + len > bytes.length) return null; out.push({ f, w, v: bytes.subarray(at, at + len) }); at += len; }
        else return null;
      }
    } catch (e) { return null; }
    return out;
  }
  function dumpProto(bytes, depth = 0) {
    const fields = strictProto(bytes, depth);
    if (!fields) return null;
    return fields.map(({ f, w, v, u32 }) => {
      if (w !== 2) return { field: f, wire: w, value: v, ...(u32 !== undefined ? { u32 } : {}) };
      let str = null;
      try { str = new TextDecoder('utf-8', { fatal: true }).decode(v); if (!/^[\P{C}\n\r\t]*$/u.test(str)) str = null; } catch (e) {}
      const nested = depth < 8 && v.length ? dumpProto(v, depth + 1) : null;
      const o = { field: f, wire: 2, len: v.length };
      if (str !== null) o.string = str.slice(0, 300);
      if (nested && nested.length) o.message = nested;
      if (str === null && !(nested && nested.length)) o.b64 = b64(v);
      return o;
    });
  }
  function grpcFrames(u8) {
    const frames = []; let at = 0;
    while (at + 5 <= u8.length) {
      const flag = u8[at], len = new DataView(u8.buffer, u8.byteOffset + at + 1, 4).getUint32(0, false);
      const body = u8.subarray(at + 5, Math.min(u8.length, at + 5 + len)); at += 5 + len;
      frames.push(flag & 0x80 || flag & 0x02 ? { trailer: new TextDecoder().decode(body) } : { flag, len, fields: dumpProto(body), b64: b64(body) });
    }
    return frames;
  }
  const L = (...a) => { if (!DEBUG) return; try { console.log('[GTC-NET]', ...a); } catch (e) {} };
  const isGrok = (url) => { try { return new URL(url, location.href).hostname.endsWith('grok.com'); } catch (e) { return false; } };
  function logBody(tag, url, ctype, u8OrText) {
    try {
      const ct = (ctype || '').toLowerCase();
      if (ct.includes('grpc') || ct.includes('proto') || ct.includes('octet') || ct.includes('connect')) {
        let u8 = u8OrText instanceof Uint8Array ? u8OrText : new TextEncoder().encode(u8OrText);
        if (ct.includes('grpc-web-text')) { // base64 body (possibly several concatenated chunks)
          const txt = new TextDecoder().decode(u8).replace(/\s/g, ''); const parts = txt.match(/[^=]+=*/g) || [];
          const bin = parts.map(pp => atob(pp)).join(''); u8 = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        }
        if (ct.includes('connect') && ct.includes('json')) { // connect streaming JSON envelopes
          L(tag + ' CONNECT-JSON', url, JSON.stringify(grpcFrames(u8).map(f => f.fields ? f : f)).slice(0, 20000), new TextDecoder().decode(u8).slice(0, MAX));
          return;
        }
        L(tag, url, ct, 'bytes=' + u8.length, 'b64(first2KB)=' + b64(u8));
        const framed = ct.includes('grpc') || ct.includes('connect+') || ct.includes('application/connect');
        const frames = framed ? grpcFrames(u8) : [{ fields: dumpProto(u8) }];
        L(tag + ' PROTO-DUMP', url, JSON.stringify(frames).slice(0, 20000));
        if (url.includes('GetGrokCreditsConfig')) L('CREDITS-RAW', JSON.stringify(frames));
        if (/prod_mc_billing/.test(url)) L('BILLING-RAW', url, JSON.stringify(frames));
        return;
      }
      const text = typeof u8OrText === 'string' ? u8OrText : new TextDecoder().decode(u8OrText);
      if (ct.includes('json') || /^\s*[\[{]/.test(text)) {
        let keys = null; try { const j = JSON.parse(text); keys = Array.isArray(j) ? ['<array len ' + j.length + '>'] : Object.keys(j); } catch (e) { keys = '<ndjson/stream or invalid json>'; }
        L(tag, url, ct, 'keys=', JSON.stringify(keys), 'body(2KB)=', text.slice(0, MAX));
      } else if (!ct.includes('html') && !ct.includes('javascript') && !ct.includes('css') && !ct.includes('image') && !ct.includes('font')) {
        L(tag, url, ct, 'text(2KB)=', text.slice(0, MAX));
      }
    } catch (e) { L('log error', url, String(e)); }
  }
  function debugFetch(method, url, init, res) {
    if (!DEBUG) return;
    if (!isGrok(url)) { if (isBilling(url)) L('not-grok host?', url); return; }
    const reqCt = (() => { try { const h = new Headers((init && init.headers) || {}); return h.get('content-type') || ''; } catch (e) { return ''; } })();
    const ct = res.headers.get('content-type') || '';
    L('fetch', method, url, 'req-ct=' + reqCt, 'status=' + res.status, 'res-ct=' + ct);
    if (/html|javascript|css|image|font|video|audio/.test(ct)) return;
    if (isBilling(url)) L('step2b cloning', url, 'ct=' + ct);
    let c; try { c = res.clone(); } catch (e) { L('clone failed', url, String(e)); return; }
    c.arrayBuffer().then(b => { if (isBilling(url)) L('step2c clone read bytes=' + b.byteLength, url); logBody('fetch-res', url, ct, new Uint8Array(b)); }).catch(e => L('read failed', url, String(e)));
  }
  if (DEBUG) {
    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__gtc = { m, u: String(u), ct: '' }; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__gtc && /content-type/i.test(k)) this.__gtc.ct = v; return XH.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      const g = this.__gtc;
      if (g) this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          L('xhr', g.m, g.u, 'req-ct=' + g.ct, 'status=' + this.status, 'res-ct=' + ct);
          const r = this.response, t = this.responseType;
          try { if (t === '' || t === 'text') scanText('xhr', g.u, this.responseText, !/javascript|css/.test(ct)); else if (t === 'json') scanText('xhr', g.u, JSON.stringify(r), true); } catch (e) {}
          if (/html|javascript|css|image|font/.test(ct)) return;
          if (t === 'arraybuffer') logBody('xhr-res', g.u, ct, new Uint8Array(r));
          else if (t === 'json') logBody('xhr-res', g.u, 'application/json', JSON.stringify(r));
          else if (t === '' || t === 'text') logBody('xhr-res', g.u, ct, this.responseText);
          else if (t === 'blob' && r) r.arrayBuffer().then(b => logBody('xhr-res', g.u, ct, new Uint8Array(b)));
          else L('xhr-res', g.u, 'responseType=' + t);
        } catch (e) {}
      });
      return XS.apply(this, arguments);
    };
    L('debug logging ON. Disable: localStorage.removeItem("gtcDebug")');
  }
  // ---------------- end debug ----------------


  // ================= [GTC-FIND] source discovery (0.4.3-debug) =================
  const STRONG = ['Grok Bot', 'grokBot', 'grok_bot', 'GrokBot', 'usagePercent', 'nextResetAtMs', 'aria-valuenow'];
  const WEAK = ['bot', '21'];
  const F = (...a) => { if (!DEBUG) return; try { console.log('[GTC-FIND]', ...a); } catch (e) {} };
  const seenSnip = new Set();
  function scanText(where, url, text, allowWeak) {
    if (!DEBUG || !text || typeof text !== 'string') return;
    const toks = allowWeak ? STRONG.concat(WEAK) : STRONG;
    let n = 0;
    for (const t of toks) {
      let i = -1, per = 0;
      while ((i = text.indexOf(t, i + 1)) !== -1 && per < 3 && n < 8) {
        if (WEAK.includes(t)) { // weak tokens: require word-ish boundary to cut noise
          const b = text[i - 1] || ' ', a = text[i + t.length] || ' ';
          if (/[A-Za-z0-9_]/.test(b) || /[A-Za-z0-9_]/.test(a)) continue;
        }
        const snip = text.slice(Math.max(0, i - 300), i + t.length + 300);
        const key = url + '|' + snip.slice(250, 360);
        if (seenSnip.has(key)) continue; seenSnip.add(key);
        F(where, 'token=' + JSON.stringify(t), 'url=' + url, 'len=' + text.length, '\n' + snip);
        per++; n++;
      }
    }
  }
  const textual = (ct) => !/image|font|video|audio|octet-stream|wasm/.test(ct || '');
  const isJsCss = (ct, url) => /javascript|css/.test(ct || '') || /\.(m?js|css)(\?|$)/.test(url || '');
  function findFromResponse(where, url, res) {
    try {
      const ct = res.headers.get('content-type') || '';
      if (!textual(ct)) { // binary/grpc: decode as latin1 too so strings inside protobuf show up
        res.clone().arrayBuffer().then(b => { const u8 = new Uint8Array(b); let s = ''; for (let i = 0; i < Math.min(u8.length, 2e6); i++) s += String.fromCharCode(u8[i]); scanText(where + '(bin)', url, s, false); }).catch(() => {});
        return;
      }
      res.clone().text().then(t => scanText(where, url, t, !isJsCss(ct, url))).catch(e => F('read failed', url, String(e)));
    } catch (e) { F('findFromResponse error', url, String(e)); }
  }
  if (DEBUG) {
    // WebSocket
    try {
      const WS = window.WebSocket;
      window.WebSocket = function (...args) {
        const ws = new WS(...args); const u = String(args[0]);
        F('WebSocket open', u);
        ws.addEventListener('message', ev => { try {
          if (typeof ev.data === 'string') scanText('ws', u, ev.data, true);
          else if (ev.data instanceof Blob) ev.data.text().then(t => scanText('ws(blob)', u, t, true));
          else if (ev.data instanceof ArrayBuffer) scanText('ws(ab)', u, new TextDecoder().decode(ev.data), true);
        } catch (e) {} });
        return ws;
      };
      window.WebSocket.prototype = WS.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    } catch (e) { F('ws hook failed', String(e)); }
    // EventSource
    try {
      const ES = window.EventSource;
      if (ES) {
        window.EventSource = function (...args) {
          const es = new ES(...args); const u = String(args[0]); F('EventSource open', u);
          es.addEventListener('message', ev => scanText('sse', u, String(ev.data), true));
          return es;
        };
        window.EventSource.prototype = ES.prototype;
      }
    } catch (e) { F('es hook failed', String(e)); }
    // Next.js flight data: self.__next_f (hook push + scan existing)
    try {
      const scanNF = (arr, tag) => { for (const item of arr || []) { try { const t = Array.isArray(item) ? item.map(x => typeof x === 'string' ? x : '').join('') : String(item); scanText(tag, '__next_f', t, true); } catch (e) {} } };
      const hookNF = (nf) => { if (!nf || nf.__gtc) return; nf.__gtc = true; const op = nf.push.bind(nf); nf.push = (...items) => { scanNF(items, 'next_f.push'); return op(...items); }; scanNF(nf, 'next_f(existing)'); };
      if (self.__next_f) hookNF(self.__next_f);
      else { let v; Object.defineProperty(self, '__next_f', { configurable: true, get() { return v; }, set(x) { v = x; try { hookNF(x); } catch (e) {} } }); }
    } catch (e) { F('next_f hook failed', String(e)); }
    // Inline scripts + server HTML once loaded
    const scanDoc = () => {
      try {
        for (const sc of document.scripts) if (!sc.src && sc.textContent) scanText('inline-script', location.href, sc.textContent, true);
        { const c = document.documentElement.cloneNode(true); c.querySelectorAll('#gtc-strip').forEach(n => n.remove()); scanText('document-html', location.href, c.outerHTML.slice(0, 5e6), false); }
        if (self.__next_f && self.__next_f.length) scanText('next_f(all)', '__next_f', JSON.stringify(self.__next_f).slice(0, 5e6), false);
      } catch (e) { F('scanDoc error', String(e)); }
    };
    if (document.readyState === 'complete') setTimeout(scanDoc, 500); else addEventListener('load', () => setTimeout(scanDoc, 500));
    // React fiber walk for the Grok Bot progressbar in the Usage dialog
    const safeJSON = (o, depth = 0, seen = new WeakSet()) => {
      if (o == null || typeof o !== 'object') return typeof o === 'function' ? '[fn]' : o;
      if (depth > 4 || seen.has(o)) return '[…]'; seen.add(o);
      if (o.$$typeof) return '[ReactElement]';
      if (o instanceof Node) return '[DOM ' + o.nodeName + ']';
      if (Array.isArray(o)) return o.slice(0, 20).map(x => safeJSON(x, depth + 1, seen));
      const out = {}; let k = 0;
      for (const key of Object.keys(o)) { if (k++ > 40) { out['…'] = '…'; break; } if (key === 'children' || key.startsWith('_owner')) continue; try { out[key] = safeJSON(o[key], depth + 1, seen); } catch (e) {} }
      return out;
    };
    const interesting = (o, depth = 0, seen = new WeakSet()) => {
      if (o == null) return false;
      if (typeof o === 'number') { const now = Date.now(), wk = 8 * 864e5; return (o > (now - wk) / 1000 && o < (now + wk) / 1000) || (o > now - wk && o < now + wk); }
      if (typeof o === 'string') return /grok\s*bot|grokBot|grok_bot|usagePercent/i.test(o);
      if (typeof o !== 'object' || depth > 5 || seen.has(o) || o.$$typeof || o instanceof Node) return false;
      seen.add(o);
      try { for (const k of Object.keys(o).slice(0, 80)) { if (/grok_?bot/i.test(k)) return true; if (interesting(o[k], depth + 1, seen)) return true; } } catch (e) {}
      return false;
    };
    let fiberDone = null;
    setInterval(() => {
      try {
        const pb = document.querySelector('[role="progressbar"][aria-label*="Grok Bot" i]');
        if (!pb) { fiberDone = null; return; }
        if (fiberDone === pb) return; fiberDone = pb;
        const fk = Object.keys(pb).find(k => k.startsWith('__reactFiber$')), pk = Object.keys(pb).find(k => k.startsWith('__reactProps$'));
        F('progressbar found; fiberKey=' + fk, 'domProps=', JSON.stringify(safeJSON(pk && pb[pk])));
        let f = fk && pb[fk], lvl = 0;
        while (f && lvl < 60) {
          const name = typeof f.type === 'string' ? f.type : (f.type && (f.type.displayName || f.type.name)) || (f.elementType && f.elementType.displayName) || '?';
          if (interesting(f.memoizedProps)) F('fiber L' + lvl, 'component=' + name, 'props=', JSON.stringify(safeJSON(f.memoizedProps)).slice(0, 4000));
          // hooks chain (useState/useQuery data etc.)
          let h = f.memoizedState, hi = 0;
          while (h && typeof h === 'object' && hi < 40 && f.tag !== 5) {
            const v = h.memoizedState;
            if (interesting(v)) F('fiber L' + lvl, 'component=' + name, 'hook#' + hi, JSON.stringify(safeJSON(v)).slice(0, 4000));
            h = h.next; hi++;
          }
          f = f.return; lvl++;
        }
        F('fiber walk done, levels=' + lvl);
        // react-query cache, if exposed via a QueryClientProvider context value
      } catch (e) { F('fiber walk error', String(e)); }
    }, 1500);
    F('find mode ON (0.4.3-debug)');
  }
  // ================= end [GTC-FIND] =================


  // ================= Grok Bot usage over wss://grok.com/ws/bot/ (JSON-RPC) =================
  // Passive: parse results with usagePercent+nextResetAtMs from the page's socket.
  // Active: open our own short-lived same-origin socket and send bot.usage.
  const NativeWS = window.WebSocket;
  const W = (...a) => { if (!DEBUG) return; try { console.log('[GTC-WS]', ...a); } catch (e) {} };
  const BOT_RE = /\/ws\/bot\//;
  let botUrl = null, botTemplate = null, botHello = null;
  try { botHello = JSON.parse(localStorage.getItem('gtcBotHello') || 'null'); } catch (e) {}
  try { botUrl = localStorage.getItem('gtcBotWsUrl'); botTemplate = JSON.parse(localStorage.getItem('gtcBotReq') || 'null'); } catch (e) {}
  function handleBotMsg(raw, via) {
    let j; try { j = typeof raw === 'string' ? JSON.parse(raw) : null; } catch (e) { return; }
    if (!j) return;
    const r = j.result || (j.params && (j.params.usage || j.params)) || j.usage;
    if (r && typeof r.usagePercent === 'number' && r.nextResetAtMs) {
      const out = { pct: r.usagePercent, resetAt: +r.nextResetAtMs, startMs: +r.currentPeriodStartMs || null, planLabel: r.planLabel || null,
        hasAvailableUsage: r.hasAvailableUsage, via, at: Date.now() };
      W('bot usage parsed', via, JSON.stringify(out));
      post('botusage', out);
    }
  }
  function wrapSocket(ws, url) {
    if (!BOT_RE.test(url)) return;
    try { botUrl = url; localStorage.setItem('gtcBotWsUrl', url); } catch (e) {}
    W('page bot socket', url);
    ws.addEventListener('message', ev => { if (typeof ev.data === 'string') { if (/bot\.|usage/i.test(ev.data)) W('recv', ev.data.slice(0, 1500)); handleBotMsg(ev.data, 'page-ws'); } });
    const os = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        if (typeof data === 'string') {
          W('send', data.slice(0, 1500));
          const j = JSON.parse(data);
          if (j && j.protocol_version && !j.jsonrpc) { botHello = j; try { localStorage.setItem('gtcBotHello', JSON.stringify(j)); } catch (e) {} W('captured hello frame', data); }
          if (j && /usage/i.test(String(j.method || ''))) { botTemplate = j; localStorage.setItem('gtcBotReq', JSON.stringify(j)); W('captured bot.usage request template', data); }
        }
      } catch (e) {}
      return os(data);
    };
  }
  try {
    const Prev = window.WebSocket; // may already be the [GTC-FIND] wrapper
    window.WebSocket = function (...args) { const ws = new Prev(...args); try { wrapSocket(ws, String(args[0])); } catch (e) {} return ws; };
    window.WebSocket.prototype = Prev.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  } catch (e) {}
  async function resolveBotUrl() {
    if (botUrl) return botUrl;
    try {
      const r = await origFetch('/api/auth/session', { credentials: 'include' });
      const j = await r.json();
      const uid = (j && (j.user && (j.user.id || j.user.userId || j.user.sub))) || j.userId || j.id || null;
      W('session keys', JSON.stringify(Object.keys(j || {})), 'uid?', uid);
      if (uid) { botUrl = `wss://${location.host}/ws/bot/?uid=${encodeURIComponent(uid)}`; try { localStorage.setItem('gtcBotWsUrl', botUrl); } catch (e) {} return botUrl; }
    } catch (e) { W('session lookup failed', String(e)); }
    return null;
  }
  let botPolling = false;
  async function pollBot() {
    if (botPolling) return; botPolling = true;
    try {
      const url = await resolveBotUrl();
      if (!url) { W('no bot ws url yet'); return; }
      const candidates = botTemplate ? [botTemplate] : [
        { jsonrpc: '2.0', method: 'bot.usage', params: {} },
        { jsonrpc: '2.0', method: 'bot.usage' }
      ];
      await new Promise((resolve) => {
        let done = false, sent = 0;
        const ws = new NativeWS(url);
        const finish = () => { if (done) return; done = true; try { ws.close(); } catch (e) {} resolve(); };
        const sendNext = () => {
          if (sent >= candidates.length) return;
          const req = Object.assign({}, candidates[sent++], { id: 'gtc-' + Date.now() + '-' + sent });
          const txt = JSON.stringify(req); W('active send', txt);
          try { ws.send(txt); } catch (e) { W('active send failed', String(e)); }
        };
        let helloOk = false;
        ws.addEventListener('open', () => {
          W('active socket open', url);
          const hello = JSON.stringify(botHello || { protocol_version: '1.0.0', kind: 'bot_client' });
          W('active send hello', hello);
          try { ws.send(hello); } catch (e) { W('hello send failed', String(e)); }
        });
        ws.addEventListener('message', ev => {
          const d = typeof ev.data === 'string' ? ev.data : '';
          W('active recv', d.slice(0, 1500));
          let j = null; try { j = JSON.parse(d); } catch (e) {}
          if (!helloOk && j && j.connection_id) { helloOk = true; W('hello ok; bot.usage supported =', Array.isArray(j.capabilities) && j.capabilities.includes('bot.usage')); sendNext(); return; }
          if (j && j.result && typeof j.result.usagePercent === 'number') { handleBotMsg(d, 'own-ws'); finish(); }
          else if (j && j.error && String(j.id || '').startsWith('gtc-')) sendNext(); // try next shape
        });
        ws.addEventListener('error', () => { W('active socket error'); finish(); });
        ws.addEventListener('close', ev => { W('active socket closed', ev.code, ev.reason); finish(); });
        setTimeout(finish, 10000);
      });
    } finally { botPolling = false; }
  }
  // ================= end ws/bot =================

  const isBilling = (u) => /prod_mc_billing|GrokBuildBilling/.test(u || '');
  window.fetch = function (input, init) {
    let url = '', method = 'GET';
    try {
      url = urlOf(input);
      method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (DEBUG && isBilling(url)) L('step1 fetch call', method, url);
    } catch (e) { L('step1 error', String(e)); }
    let p;
    try { p = origFetch(input, init); } catch (e) { L('step1b origFetch threw', url, String(e)); throw e; }
    return p.then(res => {
      if (DEBUG && isBilling(url)) L('step2 resolved', url, 'status=' + res.status, 'type=' + res.type, 'bodyUsed=' + res.bodyUsed);
      try { inspect(url, init, res); } catch (e) { L('inspect error', url, String(e)); }
      try { debugFetch(method, url, init, res); } catch (e) { L('debugFetch error', url, String(e)); }
      if (DEBUG) findFromResponse('fetch', url, res);
      return res;
    }, err => { if (DEBUG && isBilling(url)) L('step2 rejected', url, String(err)); throw err; });
  };
  if (DEBUG) L('fetch hooked');

  // Second capture path: hook Response body readers, so billing bodies are
  // dumped even if the page used a fetch reference grabbed before our hook.
  if (DEBUG) {
    for (const mname of ['arrayBuffer', 'text', 'json', 'blob']) {
      const orig = Response.prototype[mname];
      Response.prototype[mname] = function () {
        const res = this, u = res.url || '';
        const out = orig.apply(this, arguments);
        if (isBilling(u) && !res.__gtcLogged) {
          res.__gtcLogged = true;
          L('step3 body read via Response.' + mname, u);
          Promise.resolve(out).then(v => {
            try {
              const ct = res.headers.get('content-type') || 'application/grpc-web+proto';
              let u8 = null;
              if (v instanceof ArrayBuffer) u8 = new Uint8Array(v);
              else if (typeof v === 'string') return logBody('resp-read', u, ct, v);
              else if (v instanceof Blob) return v.arrayBuffer().then(b => logBody('resp-read', u, ct, new Uint8Array(b)));
              else return logBody('resp-read', u, 'application/json', JSON.stringify(v));
              logBody('resp-read', u, ct, u8);
            } catch (e) { L('step3 error', u, String(e)); }
          }, e => L('step3 read rejected', u, String(e)));
        }
        return out;
      };
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(Response.prototype, 'body');
      Object.defineProperty(Response.prototype, 'body', { configurable: true, get() {
        const b = desc.get.call(this); const u = this.url || '';
        if (b && isBilling(u) && !this.__gtcLogged && !this.__gtcTee) {
          this.__gtcTee = true; L('step3 body stream accessed', u);
          // cannot tee a stream already handed out; the debugFetch clone covers this case
        }
        return b;
      } });
    } catch (e) { L('body hook failed', String(e)); }
  }

  async function poll(models) {
    for (const m of models || ['grok-3']) {
      try {
        const r = await origFetch('/rest/rate-limits', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestKind: 'DEFAULT', modelName: m }) });
        if (r.status === 401) { post('unauthorized', {}); continue; }
        if (!r.ok) { post('error', { endpoint: 'rate-limits', status: r.status }); continue; }
        const j = await r.json(); if (DEBUG) logBody('poll-res', '/rest/rate-limits', 'application/json', JSON.stringify(j)); const n = normRate(j, m); post(n ? 'rate' : 'drift', n || { url: 'rate-limits' });
      } catch (e) { post('error', { endpoint: 'rate-limits', message: String(e) }); }
    }
    try {
      const r = await origFetch(CREDITS_PATH, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' }, body: new Uint8Array(5) });
      if (r.ok) { const buf = await r.arrayBuffer(); if (DEBUG) logBody('poll-res', CREDITS_PATH, r.headers.get('content-type') || 'application/grpc-web+proto', new Uint8Array(buf)); const c = parseCredits(buf); post(c ? 'credits' : 'drift', c || { url: 'credits' }); }
      else post('error', { endpoint: 'credits', status: r.status });
    } catch (e) { post('error', { endpoint: 'credits', message: String(e) }); }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'GTC-CS') return;
    if (ev.data.kind === 'poll') { if (DEBUG) L('poll message received'); pollBot().catch(e => W('pollBot threw', String(e))); try { poll(ev.data.models); } catch (e) { L('poll threw', String(e)); } }
  });
  post('ready', {});
})();

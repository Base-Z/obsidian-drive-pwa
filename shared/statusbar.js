/* ============================================================
   shared/statusbar.js — PWA Projects shared status bar (project 0000)
   ------------------------------------------------------------
   THE status-bar template. Every page includes this ONE file, so
   editing it updates the status bar in every app at once — there is
   nothing to copy into each app. scripts/sync-statusbar.sh only
   guarantees every page carries the include line below.

   Include in <head>, after the stylesheets:
     <script src="../shared/statusbar.js" defer></script>

   Icons, left → right:
     • Back to the all-PWAs menu   (hidden on the menu itself)
     • Server reachable?           (probes /shared/ping.txt)
     • Device online?              (navigator.onLine)
     • Service-worker status
     • Storage used / available    (ring gauge; exact figures on tap)

   Tap any icon for a text panel with the exact values.
   ============================================================ */
(function () {
  'use strict';
  if (window.__pwaStatusBar) return;   // one instance per page
  window.__pwaStatusBar = true;

  // The shared assets sit next to this script, wherever the site is mounted:
  // "/shared/" on Caddy, "/<repo>/shared/" on GitHub Pages.
  var SHARED_BASE = (function () {
    var s = document.querySelector('script[src*="statusbar.js"]');
    return s ? new URL('.', s.src).href : new URL('shared/', location.href).href;
  })();
  var PING = new URL('ping.txt', SHARED_BASE).href;
  var PROBE_MS = 20000;             // re-check server reachability every 20 s
  var STORAGE_MS = 60000;           // re-read storage estimate every 60 s
  var RING_C = 2 * Math.PI * 8;     // storage ring circumference (r = 8)

  var st = {
    server:  { v: 'checking' },
    online:  { v: navigator.onLine ? 'online' : 'offline' },
    sw:      { v: 'checking' },
    storage: { v: 'checking', frac: 0, usage: 0, quota: 0, persisted: false }
  };

  // Works at any mount depth: the menu is wherever the 4-digit app folder is
  // absent — the site root — whether that is "/" (Caddy) or "/<repo>/" (GH Pages).
  var _seg = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  var isMenu = !/^[0-9]{4}$/.test(_seg.split('/').pop() || '');

  // ---------- icons (inline SVG = zero extra requests) ----------
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var ICON = {
    apps:    svg('<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>'),
    server:  svg('<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>'),
    online:  svg('<path d="M2.5 8.5a15 15 0 0 1 19 0"/><path d="M6 12a10 10 0 0 1 12 0"/><path d="M9.5 15.5a5 5 0 0 1 5 0"/><circle cx="12" cy="19" r="1"/>'),
    sw:      svg('<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="M3 12.5 12 17l9-4.5"/><path d="M3 17 12 21.5 21 17"/>'),
    db:      svg('<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>'),
    storage: svg('<circle cx="12" cy="12" r="8" stroke-opacity=".28"/><circle class="sb-ring" cx="12" cy="12" r="8" stroke-dasharray="0 ' + RING_C.toFixed(2) + '" transform="rotate(-90 12 12)"/>')
  };

  // ---------- styles (kept here so this file IS the whole template) ----------
  var CSS =
    '#pwa-statusbar{position:fixed;top:0;left:0;right:0;z-index:2147483000;' +
    'height:calc(34px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 6px 0;' +
    'display:flex;align-items:center;gap:2px;color:#e8ecf5;' +
    'background:rgba(11,16,32,.94);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);' +
    'border-bottom:1px solid rgba(255,255,255,.10);' +
    'font:13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-user-select:none;user-select:none}' +
    '#pwa-statusbar .sb-back,#pwa-statusbar .sb-ic{width:30px;height:30px;display:inline-flex;align-items:center;' +
    'justify-content:center;border-radius:9px;border:0;margin:0;padding:0;background:none;color:#8fa0c0;' +
    'cursor:pointer;-webkit-tap-highlight-color:transparent;text-decoration:none}' +
    '#pwa-statusbar .sb-back{color:#4cc2ff}' +
    '#pwa-statusbar .sb-back svg,#pwa-statusbar .sb-ic svg{width:19px;height:19px;display:block}' +
    '#pwa-statusbar .sb-back:active,#pwa-statusbar .sb-ic:active{background:rgba(255,255,255,.07)}' +
    '#pwa-statusbar .sb-grow{flex:1 1 auto}' +
    '.sb-ok{color:#4ade80!important}.sb-warn{color:#fbbf24!important}.sb-bad{color:#fb7185!important}' +
    '.sb-dim{color:#8fa0c0!important}.sb-off{color:#6d7ea0!important}' +
    '#sb-panel{position:fixed;left:0;right:0;top:calc(34px + env(safe-area-inset-top));z-index:2147482999;' +
    'background:rgba(11,16,32,.97);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);' +
    'border-bottom:1px solid rgba(255,255,255,.10);padding:4px 12px 8px;color:#e8ecf5;' +
    'font:12.5px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '#sb-panel[hidden]{display:none}' +
    '.sb-row{display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,.06)}' +
    '.sb-row:last-child{border-bottom:0}' +
    '.sb-row .sb-ric{flex:0 0 auto}' +
    '.sb-row .sb-ric svg{width:17px;height:17px;display:block}' +
    '.sb-row .sb-k{flex:0 0 auto;color:#8fa0c0}' +
    '.sb-row .sb-v{margin-left:auto;text-align:right;font-weight:600}' +
    'body{padding-top:calc(34px + env(safe-area-inset-top))!important}';

  // ---------- build the DOM ----------
  function build() {
    var style = document.createElement('style');
    style.id = 'pwa-statusbar-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    var bar = document.createElement('header');
    bar.id = 'pwa-statusbar';
    bar.setAttribute('role', 'contentinfo');
    bar.setAttribute('aria-label', 'App status bar');
    bar.innerHTML =
      (isMenu ? '' : '<a class="sb-back" href="' + new URL('../', location.href).href + '" title="All PWAs" aria-label="Back to all PWAs">' + ICON.apps + '</a>') +
      '<span class="sb-grow"></span>' +
      '<button class="sb-ic" data-k="server"  title="Server">' + ICON.server + '</button>' +
      '<button class="sb-ic" data-k="online"  title="Network">' + ICON.online + '</button>' +
      '<button class="sb-ic" data-k="sw"      title="Service worker">' + ICON.sw + '</button>' +
      '<button class="sb-ic" data-k="storage" title="Storage">' + ICON.storage + '</button>';

    var panel = document.createElement('div');
    panel.id = 'sb-panel';
    panel.hidden = true;

    document.body.insertBefore(panel, document.body.firstChild);
    document.body.insertBefore(bar, document.body.firstChild);

    bar.addEventListener('click', function (e) {
      if (e.target.closest('.sb-back')) return;   // the back link navigates
      if (e.target.closest('.sb-ic') || e.target === bar || e.target.closest('.sb-grow')) togglePanel();
    });
    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      if (!e.target.closest('#pwa-statusbar') && !e.target.closest('#sb-panel')) panel.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') panel.hidden = true; });

    render();
  }

  function togglePanel() {
    var p = document.getElementById('sb-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) render();
  }

  // ---------- state → colour class + short label ----------
  var TITLE = { server: 'Server', online: 'Network', sw: 'Service worker', storage: 'Storage' };

  function serverState() {
    if (st.server.v === 'up')   return ['sb-ok', 'reachable'];
    if (st.server.v === 'down') return ['sb-bad', 'unreachable'];
    return ['sb-dim', 'checking…'];
  }
  function onlineState() {
    return st.online.v === 'online' ? ['sb-ok', 'online'] : ['sb-warn', 'offline'];
  }
  function swState() {
    switch (st.sw.v) {
      case 'active':      return ['sb-ok', 'active (offline-ready)'];
      case 'updating':    return ['sb-warn', 'updating…'];
      case 'registered':  return ['sb-warn', 'registered'];
      case 'none':        return ['sb-off', isMenu ? 'none (menu page)' : 'none'];
      case 'unsupported': return ['sb-off', 'unsupported'];
      case 'error':       return ['sb-bad', 'error'];
      default:            return ['sb-dim', 'checking…'];
    }
  }
  function storageState() {
    if (st.storage.v === 'unsupported') return ['sb-off', 'unsupported'];
    if (st.storage.v === 'error')       return ['sb-bad', 'error'];
    if (st.storage.v !== 'ok')          return ['sb-dim', 'reading…'];
    var f = st.storage.frac;
    return [f >= 0.9 ? 'sb-bad' : f >= 0.7 ? 'sb-warn' : 'sb-ok',
            bytes(st.storage.usage) + ' of ' + bytes(st.storage.quota)];
  }

  function bytes(n) {
    if (!n && n !== 0) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function pct() {
    var p = st.storage.frac * 100;
    return (p < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
  }

  // ---------- render ----------
  function setIcon(k, pair) {
    var b = document.querySelector('#pwa-statusbar .sb-ic[data-k="' + k + '"]');
    if (!b) return;
    b.classList.remove('sb-ok', 'sb-warn', 'sb-bad', 'sb-dim', 'sb-off');
    b.classList.add(pair[0]);
    b.title = TITLE[k] + ': ' + pair[1];
  }

  function row(key, pair, value) {
    var glyph = (key === 'storage') ? ICON.db : ICON[key];
    return '<div class="sb-row"><span class="sb-ric ' + pair[0] + '">' + glyph + '</span>' +
           '<span class="sb-k">' + TITLE[key] + '</span>' +
           '<span class="sb-v">' + value + '</span></div>';
  }

  function panelHTML() {
    var out = '';
    if (!isMenu) out += '<div class="sb-row"><span class="sb-ric" style="color:#4cc2ff">' + ICON.apps + '</span><span class="sb-k">Menu</span><span class="sb-v">tap the grid icon</span></div>';
    out += row('server', serverState(), st.server.v === 'up' ? 'reachable · ' + location.host : st.server.v === 'down' ? 'unreachable' : 'checking…');
    out += row('online', onlineState(), st.online.v === 'online' ? 'device online' : 'device offline');
    out += row('sw', swState(), swState()[1]);
    out += row('storage', storageState(), st.storage.v === 'ok'
      ? bytes(st.storage.usage) + ' of ' + bytes(st.storage.quota) + ' (' + pct() + ')' + (st.storage.persisted ? ' · persistent' : '')
      : storageState()[1]);
    return out;
  }

  function render() {
    setIcon('server', serverState());
    setIcon('online', onlineState());
    setIcon('sw', swState());
    setIcon('storage', storageState());

    var ring = document.querySelector('#pwa-statusbar .sb-ring');
    if (ring) {
      var f = st.storage.v === 'ok' ? Math.max(0, Math.min(1, st.storage.frac)) : 0;
      ring.setAttribute('stroke-dasharray', (f * RING_C).toFixed(2) + ' ' + RING_C.toFixed(2));
    }

    var panel = document.getElementById('sb-panel');
    if (panel && !panel.hidden) panel.innerHTML = panelHTML();
  }

  // ---------- probes ----------
  var probing = false;
  function probeServer() {
    if (probing) return;
    probing = true;
    if (st.server.v !== 'up') { st.server.v = 'checking'; render(); }
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
    // Unique query + no-store so neither the HTTP cache nor a service worker
    // can answer this from cache — it must reach the real server.
    fetch(PING + '?ping=' + Date.now(), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok; })
      .then(function (ok) { st.server.v = ok ? 'up' : 'down'; })
      .catch(function () { st.server.v = 'down'; })
      .then(function () { if (to) clearTimeout(to); probing = false; render(); });
  }

  function readSW() {
    if (!('serviceWorker' in navigator)) { st.sw.v = 'unsupported'; render(); return; }
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) { st.sw.v = 'none'; }
      else if (navigator.serviceWorker.controller || reg.active) { st.sw.v = 'active'; }
      else if (reg.installing || reg.waiting) { st.sw.v = 'updating'; }
      else { st.sw.v = 'registered'; }
      render();
    }).catch(function () { st.sw.v = 'error'; render(); });
  }

  function readStorage() {
    if (!navigator.storage || !navigator.storage.estimate) { st.storage.v = 'unsupported'; render(); return; }
    navigator.storage.estimate().then(function (e) {
      st.storage.usage = e.usage || 0;
      st.storage.quota = e.quota || 0;
      st.storage.frac = e.quota ? e.usage / e.quota : 0;
      st.storage.v = 'ok';
      render();
      if (navigator.storage.persisted) {
        navigator.storage.persisted().then(function (p) { st.storage.persisted = !!p; render(); }).catch(function () {});
      }
    }).catch(function () { st.storage.v = 'error'; render(); });
  }

  // ---------- start ----------
  function start() {
    build();
    readSW();
    readStorage();
    probeServer();
    setInterval(probeServer, PROBE_MS);
    setInterval(readStorage, STORAGE_MS);
    addEventListener('online',  function () { st.online.v = 'online';  render(); probeServer(); });
    addEventListener('offline', function () { st.online.v = 'offline'; render(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) probeServer(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

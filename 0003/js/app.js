/* ============================================================
   app.js — UI wiring & state for project 0003
   States: sandbox (bundled demo vault, read-only) | drive (live).
   Reading View is the default. Editing is gated behind a Drive
   Check-Out lock (spec §5.1). In sandbox mode editing is disabled.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

  const state = {
    mode: 'sandbox',      // 'sandbox' | 'drive'
    records: [],
    current: null,        // active record
    lock: 'AVAILABLE',    // AVAILABLE | CHECKED_OUT_BY_ME | LOCKED_BY_OTHER_DEVICE
    editing: false,
    draft: null
  };

  // ---------------- toast / confirm / modal ----------------
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    // Errors are ALSO written to the persistent error bar and never auto-hide
    // here, because on a phone a 3-second toast is impossible to read.
    const ms = isErr ? 15000 : 3200;
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
    if (isErr) logError(msg);
  }

  // ---------------- durable error log ----------------
  const ERR_KEY = 'odp3Errors';
  function errorHistory() {
    try { return JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch (e) { return []; }
  }
  function logError(msg, detail) {
    const entry = { t: new Date().toLocaleString(), msg: String(msg), detail: detail ? String(detail) : '' };
    try {
      const h = errorHistory();
      h.unshift(entry);
      localStorage.setItem(ERR_KEY, JSON.stringify(h.slice(0, 20)));
    } catch (e) {}
    try { console.error('[ODP]', entry.t, entry.msg, entry.detail); } catch (e) {}
    showErrBar();
  }
  function showErrBar() {
    const bar = document.getElementById('errbar');
    if (!bar) return;
    const h = errorHistory();
    if (!h.length) { bar.hidden = true; return; }
    const e = h[0];
    $('#errbarMsg').innerHTML = '';
    $('#errbarMsg').appendChild(document.createTextNode(e.msg + (e.detail ? '\n' + e.detail : '')));
    const meta = el('span', 'errbar-meta',
      e.t + (h.length > 1 ? '  ·  ' + (h.length - 1) + ' earlier error(s) logged' : ''));
    $('#errbarMsg').appendChild(meta);
    bar.hidden = false;
  }
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }
  function confirmModal(title, body) {
    return new Promise((resolve) => {
      $('#confirmTitle').textContent = title;
      $('#confirmBody').textContent = body;
      const ok = $('#confirmOk');
      const done = (v) => { closeModal('modalConfirm'); ok.onclick = null; resolve(v); };
      ok.onclick = () => done(true);
      ok.closest('.modal').querySelector('[data-close]').onclick = () => done(false);
      openModal('modalConfirm');
    });
  }

  // ---------------- rendering: tree ----------------
  function renderTree() {
    const root = $('#tree');
    root.innerHTML = '';
    const tree = ODP.VaultIndex.tree();
    if (!tree.folders.length && !tree.files.length) {
      root.appendChild(el('li', 'empty', 'Vault is empty.'));
      return;
    }
    const build = (node, parent) => {
      const ul = el('ul');
      for (const f of node.folders) {
        const li = el('li');
        const btn = el('button', 'node');
        btn.innerHTML = '<span class="tw">▾</span><span class="fc">📁</span>';
        btn.appendChild(el('span', 'nm', f.name));
        li.appendChild(btn);
        const kids = build(f, li);
        li.appendChild(kids);
        btn.onclick = () => { kids.hidden = !kids.hidden; btn.querySelector('.tw').textContent = kids.hidden ? '▸' : '▾'; };
        ul.appendChild(li);
      }
      for (const r of node.files) {
        const li = el('li');
        const btn = el('button', 'node');
        btn.dataset.path = r.path;
        const isMd = /\.md$/i.test(r.path);
        btn.innerHTML = '<span class="tw"></span><span class="fc">' + (isMd ? '📄' : '🖼️') + '</span>';
        btn.appendChild(el('span', 'nm', r.name));
        const dot = el('span', 'lockdot lock-avail');
        dot.dataset.path = r.path;
        btn.appendChild(dot);
        btn.onclick = () => openNote(r.path);
        li.appendChild(btn);
        ul.appendChild(li);
      }
      return ul;
    };
    const ul = build(tree, root);
    Array.from(ul.children).forEach(li => root.appendChild(li));
    highlightTree();
  }

  function highlightTree() {
    document.querySelectorAll('#tree .node').forEach(n => n.classList.toggle('active', n.dataset.path === (state.current && state.current.path)));
  }

  function setLockDot(path, lockState) {
    const d = document.querySelector('#tree .lockdot[data-path="' + CSS.escape(path) + '"]');
    if (!d) return;
    d.className = 'lockdot ' + (lockState === 'CHECKED_OUT_BY_ME' ? 'lock-mine' : lockState === 'LOCKED_BY_OTHER_DEVICE' ? 'lock-other' : 'lock-avail');
  }

  // ---------------- rendering: note ----------------
  function mdContext() {
    return {
      resolveWikilink(target, heading) {
        const hit = ODP.VaultIndex.resolveWikilink(target, heading, state.current && state.current.path);
        if (!hit.exists) return { exists: false, href: '#', ambiguous: hit.ambiguous };
        return { exists: true, href: '#' + encodeURIComponent(hit.path) + (heading ? '#h-' + slug(heading) : '') };
      },
      resolveEmbed(target, heading) {
        // image / attachment resolution by name
        const rec = findAttachment(target);
        if (rec) {
          const isImg = /\.(png|jpe?g|gif|svg|webp)$/i.test(rec.path) || rec.mimeType === 'image/svg+xml';
          if (isImg) {
            const url = rec.content && /^data:/.test(rec.content) ? rec.content : (rec.blobUrl || null);
            if (url) return { type: 'image', url };
          }
        }
        const hit = ODP.VaultIndex.resolveWikilink(target, heading, state.current && state.current.path);
        if (hit.exists && hit.record && typeof hit.record.content === 'string' && /\.md$/i.test(hit.path)) {
          const inner = ODP.md.render(hit.record.content, mdContext());
          return { type: 'note', html: inner.html };
        }
        return null;
      }
    };
  }

  function findAttachment(name) {
    const lower = name.toLowerCase();
    return state.records.find(r =>
      r.path.toLowerCase() === lower ||
      r.name.toLowerCase() === lower ||
      r.path.toLowerCase().endsWith('/' + lower)
    ) || null;
  }

  function slug(s) { return String(s).replace(/[^\w\u00C0-\uFFFF]+/g, '-').replace(/^-|-$/g, '').toLowerCase(); }

  function openNote(path, heading) {
    let rec = ODP.VaultIndex.byPath.get(path);
    if (!rec) {
      const hit = ODP.VaultIndex.resolveWikilink(path, null, '');
      if (hit && hit.exists) rec = hit.record;
    }
    if (!rec) {
      const lower = String(path).toLowerCase();
      rec = state.records.find(r => r.name.toLowerCase() === lower || ODP.paths.stem(r.path).toLowerCase() === lower);
    }
    if (!rec) { toast('Note not found: ' + path, true); return; }
    path = rec.path;
    if (!/\.md$/i.test(path)) {
      // attachment: show a simple preview
      state.current = rec; state.editing = false;
      const main = $('#main');
      main.innerHTML = '';
      const wrap = el('div', 'note-wrap');
      wrap.appendChild(el('h1', 'note-title', rec.name));
      wrap.appendChild(el('p', 'note-sub', rec.path));
      if (rec.content && /^data:/.test(rec.content)) {
        const img = el('img'); img.src = rec.content; img.style.maxWidth = '100%'; wrap.appendChild(img);
      }
      main.appendChild(wrap);
      if (location.hash.slice(1) !== encodeURIComponent(path)) location.hash = '#' + encodeURIComponent(path);
      updatePanels(rec);
      return;
    }
    state.current = rec;
    state.editing = false;
    state.draft = null;
    state.lock = rec.properties ? ODP.LockManager.state(rec) : 'AVAILABLE';
    renderReading();
    if (location.hash.slice(1) !== encodeURIComponent(path)) location.hash = '#' + encodeURIComponent(path);
    highlightTree();
    updatePanels(rec);
    if (heading) {
      setTimeout(() => {
        const t = document.getElementById('h-' + slug(heading));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  }

  function renderReading() {
    const rec = state.current;
    const main = $('#main');
    main.innerHTML = '';
    const wrap = el('div', 'note-wrap');

    const head = el('div', 'note-head');
    head.appendChild(el('h1', 'note-title', ODP.paths.stem(rec.path)));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'note-sub', rec.path + (rec.modifiedTime ? ' · ' + new Date(rec.modifiedTime).toLocaleString() : '')));

    wrap.appendChild(lockBar());

    const body = el('div', 'md');
    const rendered = ODP.md.render(rec.content || '', mdContext());
    body.innerHTML = rendered.html;
    wrap.appendChild(body);
    main.appendChild(wrap);
    main.scrollTop = 0;
  }

  function lockBar() {
    const bar = el('div', 'lockbar');
    if (state.mode === 'sandbox') {
      bar.classList.add('avail');
      bar.innerHTML = '<div class="grow">📦 Sandbox vault — <b>read-only</b>. Sign in to Google Drive to edit and lock notes.</div>';
      return bar;
    }
    if (state.lock === 'CHECKED_OUT_BY_ME') {
      bar.classList.add('mine');
      bar.innerHTML = '<div class="grow">🔒 <b>Checked out by you</b> — editing enabled.</div>';
      const edit = el('button', 'tbtn primary', 'Edit');
      edit.onclick = enterEditor;
      bar.appendChild(edit);
      return bar;
    }
    if (state.lock === 'LOCKED_BY_OTHER_DEVICE') {
      bar.classList.add('other');
      const o = ODP.LockManager.owner(state.current);
      bar.innerHTML = '<div class="grow">⛔ Checked out by <b>' + escapeHtml(o.device) + '</b> at ' +
        (o.at ? new Date(o.at).toLocaleString() : 'unknown time') + '. Read-only.</div>';
      const fu = el('button', 'tbtn', 'Force Unlock');
      fu.onclick = forceUnlock;
      bar.appendChild(fu);
      return bar;
    }
    // AVAILABLE
    bar.classList.add('avail');
    bar.innerHTML = '<div class="grow">✏️ Read-only. Check out to edit.</div>';
    const co = el('button', 'tbtn primary', 'Check Out to Edit');
    co.onclick = checkOut;
    bar.appendChild(co);
    const pend = el('span');
    bar.appendChild(pend);
    maybeShowPending(bar);
    return bar;
  }

  async function maybeShowPending(bar) {
    let drafts = [];
    try { drafts = await ODP.store.drafts.all(); } catch (e) { return; }
    const mine = drafts.find(d => d.id === (state.current && state.current.id));
    if (mine) {
      const b = el('button', 'tbtn', 'Pending Check-In (1 note)');
      b.onclick = resumeDraft;
      bar.appendChild(b);
    }
  }

  function resumeDraft() { toast('Resuming checked-out draft…'); enterEditor(); }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------------- editor ----------------
  // Recover any locally-stored draft for this note. This is what makes a
  // token expiry (or a reload) mid-edit non-destructive: the text lives in
  // IndexedDB, not only in the DOM.
  async function loadDraft(rec) {
    if (state.draft != null) return state.draft;
    try {
      const d = await ODP.store.drafts.get(rec.id);
      if (d && typeof d.content === 'string') state.draft = d.content;
    } catch (e) { /* storage unavailable — fall back to the Drive copy */ }
    return state.draft;
  }

  // Debounced autosave of the working draft.
  async function persistDraft(content) {
    const rec = state.current;
    if (!rec) return;
    try {
      await ODP.store.drafts.set({
        id: rec.id, path: rec.path, content, savedAt: new Date().toISOString()
      });
      $('#stMsg').textContent = 'draft saved locally ' + new Date().toLocaleTimeString();
    } catch (e) {
      $('#stMsg').textContent = 'draft NOT saved (storage unavailable)';
    }
  }

  async function enterEditor(content) {
    state.editing = true;
    const rec = state.current;
    const stored = await loadDraft(rec);
    const main = $('#main');
    main.innerHTML = '';
    const wrap = el('div', 'editor-wrap');

    const head = el('div', 'note-head');
    head.appendChild(el('h1', 'note-title', ODP.paths.stem(rec.path)));
    wrap.appendChild(head);

    const tb = el('div', 'editor-toolbar');
    const save = el('button', 'tbtn primary', 'Check In (Save & Unlock)');
    const draft = el('button', 'tbtn', 'Save Draft to Drive');
    const discard = el('button', 'tbtn', 'Discard & Unlock');
    const preview = el('button', 'tbtn', 'Preview');
    tb.append(save, draft, discard, preview);
    wrap.appendChild(tb);

    const ta = el('textarea', 'editor');
    ta.value = content != null ? content
             : (stored != null ? stored : (rec.content || ''));
    wrap.appendChild(ta);

    // Autosave as you type (debounced) so nothing is lost on expiry/reload.
    let saveTimer = null;
    ta.addEventListener('input', () => {
      state.draft = ta.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persistDraft(ta.value), 700);
    });

    const prev = el('div', 'md');
    prev.style.display = 'none';
    wrap.appendChild(prev);
    let previewOn = false;
    preview.onclick = () => {
      previewOn = !previewOn;
      prev.style.display = previewOn ? 'block' : 'none';
      ta.style.display = previewOn ? 'none' : 'block';
      if (previewOn) prev.innerHTML = ODP.md.render(ta.value, mdContext()).html;
      preview.textContent = previewOn ? 'Source' : 'Preview';
    };

    save.onclick = () => { clearTimeout(saveTimer); doCheckIn(ta.value); };
    draft.onclick = () => { clearTimeout(saveTimer); doSaveDraft(ta.value); };
    discard.onclick = () => { clearTimeout(saveTimer); doDiscard(); };
    main.appendChild(wrap);
    ta.focus();
  }

  // ---------------- lock operations (drive mode) ----------------
  async function checkOut() {
    const rec = state.current;
    try {
      const meta = await ODP.drive.getMeta(rec.id);
      if (ODP.LockManager.state(meta) !== 'AVAILABLE') {
        toast('Note is already locked.', true);
        state.lock = ODP.LockManager.state(meta);
        renderReading(); return;
      }
      toast('Acquiring lock…');
      await ODP.drive.patchProperties(rec.id, ODP.LockManager.acquireBody(meta).properties);
      // Read-after-write verification (Drive has no atomic CAS).
      const verify = await ODP.drive.getMeta(rec.id);
      if (ODP.LockManager.state(verify) !== 'CHECKED_OUT_BY_ME') {
        state.lock = 'LOCKED_BY_OTHER_DEVICE';
        toast('Another device won the lock. Read-only.', true);
        renderReading(); return;
      }
      rec.properties = verify.properties; rec.headRevisionId = verify.headRevisionId;
      state.lock = 'CHECKED_OUT_BY_ME';
      setLockDot(rec.path, state.lock);
      const content = await ODP.drive.getContent(rec.id);
      rec.content = content;
      renderReading();
      enterEditor(content);
      toast('Checked out.');
    } catch (e) { toast(e.message || String(e), true); }
  }

  async function doCheckIn(content) {
    const rec = state.current;
    try {
      const meta = await ODP.drive.getMeta(rec.id);
      const props = meta.properties || {};
      const valid = props[ODP.LockManager.OWNER_INST] === ODP.config.instanceId && props[ODP.LockManager.OWNER_REV] === meta.headRevisionId;
      if (!valid) {
        const ok = await confirmModal('Lock broken', 'The lock changed or the revision moved. Save your edits as a conflict copy instead?');
        if (!ok) return;
        await saveConflictCopy(content);
        return;
      }
      const norm = String(content).replace(/\r\n?/g, '\n');
      await ODP.drive.updateFile(rec.id, norm, ODP.LockManager.releaseBody().properties);
      rec.content = norm; rec.properties = {};
      state.lock = 'AVAILABLE'; state.editing = false; state.draft = null;
      await ODP.store.drafts.del(rec.id);
      setLockDot(rec.path, 'AVAILABLE');
      renderReading();
      ODP.VaultIndex.build(state.records);
      updatePanels(rec);
      toast('Checked in and unlocked.');
    } catch (e) { toast(e.message || String(e), true); }
  }

  async function doSaveDraft(content) {
    const rec = state.current;
    state.draft = content;
    await ODP.store.drafts.set({ id: rec.id, path: rec.path, content, savedAt: new Date().toISOString() });
    toast('Draft saved to Drive (still checked out).');
    // push a draft copy to Drive without releasing the lock
    try { await ODP.drive.updateFile(rec.id, String(content).replace(/\r\n?/g, '\n')); }
    catch (e) { toast('Draft kept locally; Drive write failed: ' + (e.message || e), true); }
  }

  async function doDiscard() {
    const ok = await confirmModal('Discard edits?', 'Your unsaved changes will be lost and the lock released.');
    if (!ok) return;
    try { await ODP.drive.patchProperties(state.current.id, ODP.LockManager.releaseBody().properties); } catch (e) {}
    await ODP.store.drafts.del(state.current.id);
    state.lock = 'AVAILABLE'; state.editing = false; state.draft = null;
    setLockDot(state.current.path, 'AVAILABLE');
    renderReading(); toast('Discarded and unlocked.');
  }

  async function forceUnlock() {
    const ok = await confirmModal('Force Unlock',
      'This releases the lock even if another device may still be editing. If it later pushes changes, a conflict copy may result.');
    if (!ok) return;
    try {
      await ODP.drive.patchProperties(state.current.id, ODP.LockManager.releaseBody().properties);
      state.lock = 'AVAILABLE'; renderReading(); toast('Lock released.');
    } catch (e) { toast(e.message || String(e), true); }
  }

  async function saveConflictCopy(content) {
    const rec = state.current;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const name = ODP.paths.stem(rec.path) + ' (Conflict ' + stamp + ').md';
    const parent = (rec.parents && rec.parents[0]) || ODP.drive.rootVaultFolderId;
    await ODP.drive.createFile(name, parent, String(content).replace(/\r\n?/g, '\n'));
    toast('Saved conflict copy: ' + name);
  }

  // ---------------- panels ----------------
  function updatePanels(rec) {
    const idx = ODP.VaultIndex;
    const bl = $('#backlinks'); bl.innerHTML = '';
    const back = idx.backlinks(rec.path);
    if (!back.length) bl.appendChild(el('li', 'rp-empty', 'No backlinks.'));
    else back.forEach(b => { const li = el('li'); const a = el('button', null, idx.byPath.get(b.path).name.replace(/\.md$/, '')); a.onclick = () => openNote(b.path); li.appendChild(a); bl.appendChild(li); });

    const ol = $('#outlinks'); ol.innerHTML = '';
    const out = idx.outgoing(rec.path);
    if (!out.length) ol.appendChild(el('li', 'rp-empty', 'No outgoing links.'));
    else out.forEach(o => {
      const li = el('li');
      const a = el('button', null, o.target + (o.hit.exists ? '' : ' ⟶ missing'));
      if (o.hit.exists) a.onclick = () => openNote(o.hit.path); else a.style.opacity = '.55';
      li.appendChild(a); ol.appendChild(li);
    });

    const tagsEl = $('#tags'); tagsEl.innerHTML = '';
    const tags = rec.content ? (ODP.md.render(rec.content, {}).tags || []) : [];
    if (!tags.length) tagsEl.appendChild(el('span', 'rp-empty', 'No tags.'));
    else tags.forEach(t => {
      const c = el('span', 'chip', '#' + t);
      c.onclick = () => { $('#searchInput').value = '#' + t; openModal('modalSearch'); runSearch('#' + t); };
      tagsEl.appendChild(c);
    });
  }

  // ---------------- quick switcher / search ----------------
  function runQuick(q) {
    const list = $('#quickList'); list.innerHTML = '';
    const items = ODP.VaultIndex.quickSwitch(q);
    if (!items.length) { list.appendChild(el('li', 'rp-empty', 'No matches.')); return; }
    items.forEach((it, i) => {
      const li = el('li');
      li.innerHTML = '<div class="rt">' + escapeHtml(it.title) + '</div><div class="rp">' + escapeHtml(it.path) + '</div>';
      li.onclick = () => { closeModal('modalQuick'); openNote(it.path); };
      list.appendChild(li);
    });
    const first = list.querySelector('li'); if (first && !first.classList.contains('rp-empty')) first.classList.add('sel');
  }

  function runSearch(q) {
    const list = $('#searchList'); list.innerHTML = '';
    if (!q) return;
    const tag = /^#/.test(q);
    const results = tag
      ? [...(ODP.VaultIndex.tagMap.get(q.slice(1)) || [])].map(p => ({ path: p, title: ODP.paths.stem(p), snippet: 'tagged #' + q.slice(1) }))
      : ODP.VaultIndex.search(q);
    if (!results.length) { list.appendChild(el('li', 'rp-empty', 'No matches.')); return; }
    results.forEach(r => {
      const li = el('li');
      li.innerHTML = '<div class="rt">' + escapeHtml(r.title) + '</div><div class="rp">' + escapeHtml(r.path) + '</div>' +
        (r.snippet ? '<div class="rs">' + escapeHtml(r.snippet) + '</div>' : '');
      li.onclick = () => { closeModal('modalSearch'); openNote(r.path); };
      list.appendChild(li);
    });
  }

  // ---------------- status / auth ----------------
  function updateStatus() {
    $('#stMode').textContent = state.mode === 'drive' ? 'Google Drive' : 'sandbox';
    $('#stNotes').textContent = state.records.filter(r => /\.md$/i.test(r.path)).length + ' notes';
    const badge = $('#vaultBadge');
    if (state.mode === 'drive') {
      badge.classList.remove('sandbox');
      badge.textContent = 'Active Vault: ' + (localStorage.getItem('odp3RootName') || ODP.config.vaultFolderDefaultName);
    } else {
      badge.classList.add('sandbox');
      badge.textContent = 'Active Vault: ObsidianVault-New [Sandbox / Legacy Vault Preserved]';
    }
  }

  // Google cannot register a raw IP address as an OAuth origin, so sign-in can
  // only ever work from the public origin. Detect the LAN address and say so
  // plainly instead of letting Google answer with a bare `origin_mismatch`.
  function isLanIpOrigin() {
    const h = location.hostname;
    // Google exempts localhost IPs, so those are fine even though they're IPs.
    if (h === 'localhost' || h === '[::1]' || h === '::1' || /^127\./.test(h)) return false;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  }

  function updateAuthUi() {
    const btn = $('#btnAuth');
    if (ODP.auth.isSignedIn()) { btn.textContent = 'Signed in'; btn.classList.remove('primary'); }
    else if (isLanIpOrigin()) { btn.textContent = 'Sign in (public URL only)'; btn.classList.remove('primary');
      btn.title = 'Google sign-in requires https://base-z.github.io — a raw IP cannot be registered.'; }
    else if (!ODP.auth.isConfigured()) { btn.textContent = 'Drive: not configured'; btn.title = 'Add a Google OAuth client id in js/config.js'; }
    else { btn.textContent = 'Sign in to Drive'; btn.classList.add('primary'); }
  }

  async function connectDrive() {
    if (isLanIpOrigin()) {
      logError('Google sign-in is not available from the LAN address.',
        'You are on ' + location.origin + '. Google rejects raw IP addresses as OAuth origins ' +
        '(only localhost is exempt), so sign in from the public URL instead:\n' +
        'https://base-z.github.io/obsidian-drive-pwa/0003/');
      toast('Sign in from the public URL — see the red bar below.', true);
      return;
    }
    if (!ODP.auth.isConfigured()) {
      toast('No OAuth client id yet — sandbox mode. See the project Execution Log.', true);
      return;
    }
    try {
      await ODP.auth.signIn();
      localStorage.setItem('odp3Connected', '1');
      toast('Signed in. Loading vault…');
      await loadDrive();
    } catch (e) { toast(e.message || String(e), true); }
  }

  // Boot-time resume: only if the user has connected before, and only silently.
  // A failure leaves sandbox mode untouched and prompts nothing.
  async function resumeDrive() {
    try {
      // 1. A still-valid persisted token — no network, no popup.
      if (await ODP.auth.restore()) {
        localStorage.setItem('odp3Connected', '1');
        await loadDrive();
        return;
      }
      // 2. Silent renewal (no UI).
      await ODP.auth.renewSilently();
      localStorage.setItem('odp3Connected', '1');
      await loadDrive();
    } catch (e) {
      updateAuthUi();   // stay in sandbox
      // Log WHY — otherwise the failure is invisible and undebuggable.
      let saved = null;
      try { saved = await ODP.store.getMeta('accessToken', null); } catch (e2) {}
      logError('Could not resume the Drive session',
        'reason: ' + ((e && e.message) || e) +
        '\nconnected flag: ' + localStorage.getItem('odp3Connected') +
        '\nsaved token: ' + (saved && saved.value ? 'present (expires ' + new Date(saved.expiresAt).toLocaleString() + ')' : 'none') +
        '\norigin: ' + location.origin);
      // A silent renewal needs a user gesture to open its (invisible) popup,
      // so retry once on the first touch/click rather than making the user
      // hunt for the Sign in button.
      if (!ODP.auth.isSignedIn()) armGestureResume();
    }
  }

  // Screen-readable diagnostics. Tapping ⓘ puts this in the persistent error
  // bar so it can be read and screenshotted from a phone.
  async function diagnostics() {
    let saved = null;
    try { saved = await ODP.store.getMeta('accessToken', null); } catch (e) {}
    const ua = navigator.userAgent || '';
    const inApp = /Telegram|FBAN|FBAV|Instagram|Line\/|wv\)/.test(ua);
    let syncInfo = 'no folder chosen';
    try {
      const h = await ODP.store.handles.get('localDir');
      if (h) {
        const key = ODP.sync.manifestKey(h.name);
        const m = await ODP.sync.loadManifest(key);
        syncInfo = h.name + ' · key=' + key + ' · baseline=' +
                   (m ? Object.keys(m).length + ' entr(ies)' : 'NONE — every run re-classifies from scratch');
      }
    } catch (e) { syncInfo = 'error: ' + ((e && e.message) || e); }
    const lines = [
      'origin: ' + location.origin,
      'path: ' + location.pathname,
      'mode: ' + state.mode,
      'secure ctx: ' + window.isSecureContext,
      'connected flag: ' + (localStorage.getItem('odp3Connected') || 'not set'),
      'token in memory: ' + (ODP.auth.isSignedIn() ? 'valid' : 'none/expired'),
      'token in storage: ' + (saved && saved.value
        ? 'present, expires ' + new Date(saved.expiresAt).toLocaleString()
        : 'none'),
      'indexedDB: ' + (state.storageOff ? 'UNAVAILABLE' : 'ok'),
      'client id set: ' + ODP.auth.isConfigured(),
      'vault root id: ' + (ODP.drive.rootVaultFolderId || 'not set'),
      'sync: ' + syncInfo,
      'standalone app: ' + (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true),
      'in-app browser: ' + (inApp ? 'LIKELY — storage may not persist' : 'no'),
      'sw controlling: ' + !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      'UA: ' + ua.slice(0, 90)
    ];
    logError('Diagnostics', lines.join('\n'));
  }

  let gestureResumeArmed = false;
  function armGestureResume() {
    if (gestureResumeArmed) return;
    gestureResumeArmed = true;
    const handler = () => {
      document.removeEventListener('pointerdown', handler);
      gestureResumeArmed = false;
      if (!ODP.auth.isSignedIn()) resumeDrive();
    };
    document.addEventListener('pointerdown', handler, { passive: true });
  }

  // First-run onboarding (spec §2.4): seed the brand-new vault with a small set
  // of starter notes that exercise every renderer feature, so the acceptance
  // tests have something real to run against.
  async function seedStarterNotes(rootId) {
    const folderIds = new Map([['', rootId]]);
    const folderFor = async (dir) => {
      if (folderIds.has(dir)) return folderIds.get(dir);
      const parts = dir.split('/');
      const parentId = await folderFor(parts.slice(0, -1).join('/'));
      const created = await ODP.drive.createFolder(parts[parts.length - 1], parentId);
      folderIds.set(dir, created.id);
      return created.id;
    };
    for (const note of ODP.demo.notes()) {
      const dir = note.path.split('/').slice(0, -1).join('/');
      const parentId = dir ? await folderFor(dir) : rootId;
      // demo.js stores the attachment as a data: URI — decode it so the file
      // lands in Drive as real bytes rather than a data URI string.
      let body = note.content || '';
      let mime = note.mimeType || 'text/markdown';
      const dm = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(body);
      if (dm) {
        mime = dm[1];
        body = dm[2] ? atob(dm[3]) : decodeURIComponent(dm[3]);
      }
      await ODP.drive.createFile(note.path.split('/').pop(), parentId, body, mime);
    }
  }

  async function loadDrive() {
    const name = ODP.config.vaultFolderDefaultName;
    const root = await ODP.drive.ensureVaultRoot(name);
    localStorage.setItem('odp3RootName', name);
    try {
      // Changes API page token is an incremental-refresh optimisation only —
      // never let it block first load.
      let token = await ODP.store.getMeta('changesStartToken', null);
      if (!token) { token = await ODP.drive.getStartPageToken(); await ODP.store.meta.set('changesStartToken', token); }
    } catch (e) { /* ignore */ }

    let files = await ODP.drive.buildTree(root.id);
    let md = files.filter(f => /\.md$/i.test(f.path));

    if (!md.length) {
      toast('New vault — creating starter test notes…');
      await seedStarterNotes(root.id);
      files = await ODP.drive.buildTree(root.id);
      md = files.filter(f => /\.md$/i.test(f.path));
      toast('Created ' + md.length + ' starter notes in ' + name + '/');
    }

    state.mode = 'drive';
    state.records = files;
    // Fetch .md bodies for indexing / search / backlinks.
    await Promise.all(md.map(async f => {
      try { f.content = (await ODP.drive.getContent(f.id)).replace(/\r\n?/g, '\n'); } catch (e) {}
    }));
    ODP.VaultIndex.build(state.records);
    renderTree(); updateStatus(); updateAuthUi();
    if (md.length) toast('Vault loaded: ' + md.length + ' notes.');
    const first = md.find(f => /(^|\/)Welcome\.md$/.test(f.path)) || md[0];
    if (first && !location.hash) openNote(first.path);
  }

  function loadSandbox() {
    state.mode = 'sandbox';
    state.records = ODP.demo.notes();
    ODP.VaultIndex.build(state.records);
    renderTree(); updateStatus(); updateAuthUi();
    const h = location.hash.slice(1);
    if (h) { openNote(decodeURIComponent(h)); }
    else openNote('Welcome');
  }

  // ---------------- events ----------------
  function wire() {
    $('#btnMenu').onclick = () => { $('#sidebar').classList.toggle('open'); $('#rightbar').classList.remove('open'); };
    $('#btnRight').onclick = () => { $('#rightbar').classList.toggle('open'); $('#sidebar').classList.remove('open'); };
    $('#btnAuth').onclick = connectDrive;
    $('#btnDiag').onclick = () => diagnostics();
    $('#btnSync').onclick = () => openSync();
    $('#syncPick').onclick = () => pickFolder();
    $('#syncScan').onclick = () => doScan();
    $('#syncReset').onclick = () => doResetBaseline();
    $('#syncExecute').onclick = () => doExecute();
    $('#syncExportZip').onclick = () => doExportZip();
    $('#syncImportZipBtn').onclick = () => $('#syncImportZip').click();
    $('#syncImportZip').onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) doImportZip(f);
      e.target.value = '';
    };

    $('#btnQuick').onclick = () => { openModal('modalQuick'); const i = $('#quickInput'); i.value = ''; runQuick(''); i.focus(); };
    $('#quickInput').oninput = (e) => runQuick(e.target.value);
    $('#quickInput').onkeydown = (e) => {
      if (e.key === 'Enter') { const li = document.querySelector('#quickList li.sel') || document.querySelector('#quickList li'); if (li) li.click(); }
    };
    $('#btnSearch').onclick = () => { openModal('modalSearch'); const i = $('#searchInput'); i.value = ''; $('#searchList').innerHTML = ''; i.focus(); };
    $('#searchInput').oninput = (e) => runSearch(e.target.value);

    document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));
    document.querySelectorAll('.modal-back').forEach(m => m.onclick = (e) => { if (e.target === m) m.classList.remove('open'); });

    // delegated clicks inside rendered markdown
    $('#main').addEventListener('click', (e) => {
      const a = e.target.closest('a.wikilink');
      if (a) {
        e.preventDefault();
        const target = a.dataset.wikilink;
        const heading = a.dataset.heading;
        const hit = ODP.VaultIndex.resolveWikilink(target, heading, state.current && state.current.path);
        if (hit.exists) openNote(hit.path, heading);
        else toast('Unresolved link: ' + target, true);
        return;
      }
      const tag = e.target.closest('a.tag');
      if (tag) { e.preventDefault(); const t = '#' + tag.dataset.tag; $('#searchInput').value = t; openModal('modalSearch'); runSearch(t); }
    });

    window.addEventListener('hashchange', () => {
      const h = location.hash.slice(1);
      if (h) { const p = decodeURIComponent(h).split('#')[0]; if (!state.current || state.current.path !== p) openNote(p); }
    });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#btnQuick').click(); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#btnSearch').click(); }
      if (e.key === 'Escape') { document.querySelectorAll('.modal-back.open').forEach(m => m.classList.remove('open')); }
    });

    window.addEventListener('online', () => $('#stMsg').textContent = 'online');
    window.addEventListener('offline', () => $('#stMsg').textContent = 'offline — drafts kept locally');

    // Persistent error bar: errors stay until dismissed so they can be read
    // and screenshotted on a phone.
    $('#errbarClose').onclick = () => {
      try { localStorage.removeItem(ERR_KEY); } catch (e) {}
      $('#errbar').hidden = true;
    };
    window.addEventListener('error', (ev) => logError(
      'Uncaught error: ' + (ev.message || 'unknown'),
      ev.filename ? ev.filename.split('/').slice(-2).join('/') + ':' + ev.lineno : ''));
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      logError('Unhandled rejection: ' + ((r && (r.message || r)) || 'unknown'));
    });
  }

  // ---------------- local vault sync UI (spec §5.3) ----------------
  const syncState = { dirHandle: null, scan: null, mode: 'directory' };

  function actionLabel(a) {
    return ({ pull: 'Pull', push: 'Push', conflict: 'Conflict',
              'delete-local': 'Delete local', 'delete-remote': 'Delete remote', none: 'No change' })[a] || a;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  async function openSync() {
    const supports = ODP.sync.supportsDirectoryPicker();
    $('#syncIntro').textContent = supports
      ? 'Sync this vault with a local Obsidian folder, on demand. Nothing runs in the background.'
      : 'This browser has no File System Access API, so use the ZIP export/import path instead.';
    $('#syncPick').hidden = !supports;
    $('#syncHint').textContent = supports
      ? 'Pick a dedicated subfolder (e.g. Documents/ObsidianVault-New). Android will not let you pick the root of internal storage.'
      : 'Export a ZIP, unzip it into your Obsidian vault folder; then import a ZIP back to push changes up.';
    $('#syncList').innerHTML = '';
    $('#syncSummary').textContent = '';
    $('#syncExecute').disabled = true;
    try {
      const h = await ODP.store.handles.get('localDir');
      if (h) {
        syncState.dirHandle = h;
        $('#syncFolderName').textContent = h.name + (supports ? '' : ' (this browser cannot re-open it)');
        $('#syncScan').disabled = false;
        $('#syncReset').hidden = false;
        if (supports && typeof h.queryPermission === 'function') {
          const p = await h.queryPermission({ mode: 'readwrite' });
          if (p !== 'granted') {
            $('#syncHint').textContent = 'Access to "' + h.name + '" has to be confirmed again — Chrome does not ' +
              'remember folder permission between visits. Tap "Scan & Preview Sync" to confirm it now, or ' +
              '"Choose folder…" to pick it again.';
          }
        }
      }
    } catch (e) {}
    openModal('modalSync');
  }

  async function pickFolder() {
    try {
      const h = await ODP.sync.pickDirectory();
      syncState.dirHandle = h;
      try { await ODP.store.handles.set('localDir', h); } catch (e) {}
      $('#syncFolderName').textContent = h.name;
      $('#syncScan').disabled = false;
      toast('Folder connected: ' + h.name);
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return;  // user cancelled
      logError('Could not open the folder picker', (e && e.message) || String(e));
    }
  }

  function updateExecuteBtn() {
    const plan = (syncState.scan && syncState.scan.plan) || [];
    const n = plan.filter(i => i.selected && i.action !== 'none' && !i.lockedByOther).length;
    $('#syncExecute').disabled = n === 0;
    $('#syncExecute').textContent = 'Execute selected (' + n + ')';
  }

  function renderPlan() {
    const list = $('#syncList'); list.innerHTML = '';
    const plan = (syncState.scan && syncState.scan.plan) || [];
    const counts = {};
    for (const i of plan) counts[i.action] = (counts[i.action] || 0) + 1;
    $('#syncSummary').textContent = Object.entries(counts)
      .map(([k, v]) => actionLabel(k) + ': ' + v).join('   ·   ') || 'Nothing to do.';
    const order = ['conflict', 'delete-local', 'delete-remote', 'pull', 'push', 'none'];
    for (const item of [...plan].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action))) {
      const li = el('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const selectable = item.action !== 'none' && !item.lockedByOther;
      cb.checked = selectable;
      cb.disabled = !selectable;
      item.selected = selectable;
      cb.onchange = () => { item.selected = cb.checked; updateExecuteBtn(); };
      li.appendChild(cb);
      li.appendChild(el('span', 'plan-badge badge-' + item.action, actionLabel(item.action)));
      const txt = el('div', 'plan-text');
      txt.appendChild(el('div', 'plan-path', item.path));
      txt.appendChild(el('div', 'plan-why',
        item.reason + (item.lockedByOther ? '  ·  locked by another device — will be skipped' : '')));
      if (item.action === 'conflict') {
        // Without an explicit choice the only safe option is to keep both, which
        // is why copies accumulated. Let the user decide which version wins.
        item.resolution = item.resolution || 'both';
        const sel = document.createElement('select');
        sel.className = 'resolve';
        for (const [v, label] of [['both', 'Keep both (2 copies)'],
                                  ['remote', 'Take the Drive version'],
                                  ['local', 'Keep my local version']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = label; sel.appendChild(o);
        }
        sel.value = item.resolution;
        sel.onchange = () => { item.resolution = sel.value; };
        txt.appendChild(sel);
        txt.appendChild(el('div', 'plan-why',
          'local ' + fmtBytes(item.local && item.local.bytes && item.local.bytes.length) +
          '  ·  drive ' + fmtBytes(item.remote && item.remote.size) +
          (item.remote && item.remote.modifiedTime
            ? '  ·  drive changed ' + new Date(item.remote.modifiedTime).toLocaleString() : '')));
      }
      li.appendChild(txt);
      list.appendChild(li);
    }
    updateExecuteBtn();
  }

  // Chrome/Android refuse access to a restored folder until it is re-confirmed
  // by a tap — the raw DOMException is meaningless to a user.
  function friendlyFsError(e) {
    const m = (e && e.message) || String(e);
    if ((e && e.code === 'PERMISSION') ||
        (e && e.name === 'NotAllowedError') ||
        /not allowed by the user agent|request is not allowed/i.test(m)) {
      return 'Chrome needs you to re-confirm access to the folder (it is not remembered between ' +
             'visits, especially on Android). Tap "Choose folder…" and pick it again.';
    }
    if (e && e.name === 'AbortError') return 'Cancelled.';
    return m;
  }

  async function doScan() {
    if (!syncState.dirHandle) return;
    const prog = $('#syncProgress');
    prog.hidden = false; prog.textContent = 'Reading the local folder…';
    $('#syncList').innerHTML = ''; $('#syncExecute').disabled = true;
    try {
      let res = await ODP.sync.scanDirectory(syncState.dirHandle, { allowDeletes: false });
      if (res.guard) {
        const ok = await confirmModal('Is this the right folder?',
          res.guard.message + '  Continue only if this folder is the NEW vault.');
        if (!ok) { prog.textContent = 'Cancelled — nothing was changed.'; return; }
        prog.textContent = 'Re-scanning…';
        res = await ODP.sync.scanDirectory(syncState.dirHandle, { allowDeletes: false, acceptedGuard: true });
      }
      syncState.mode = 'directory';
      syncState.scan = res;
      prog.textContent = 'Compared ' + res.local.size + ' local file(s) with Drive · baseline: ' +
        (res.baselineCount ? res.baselineCount + ' file(s)' : 'none yet — this is the first run');
      renderPlan();
      if (!res.plan.some(i => i.action !== 'none')) toast('Already in sync — nothing to do.');
    } catch (e) {
      prog.textContent = 'Scan failed.';
      logError('Local sync scan failed', friendlyFsError(e));
    }
  }

  async function doExecute() {
    if (!syncState.scan) return;
    const prog = $('#syncProgress');
    prog.hidden = false;
    $('#syncExecute').disabled = true;
    try {
      const cb = (done, total, item, status) => {
        prog.textContent = done + '/' + total + '  ' + item.path +
          (status && status !== 'done' ? '  — ' + status : '');
      };
      let r;
      if (syncState.mode === 'zip') r = await ODP.sync.executeImport(syncState.scan.plan, cb);
      else r = await ODP.sync.executeDirectory(syncState.dirHandle, syncState.scan, syncState.scan.plan, cb);
      prog.textContent = 'Finished: ' + r.done + ' of ' + r.total + ' processed.' +
        (r.manifestSaved === false
          ? '  ⚠ The baseline could NOT be saved — re-running may create duplicate conflict copies. ' +
            'Tap ⓘ and send me the diagnostics.'
          : (r.baselineCount != null ? '  Baseline saved (' + r.baselineCount + ' files).' : ''));
      toast('Sync complete.');
      if (syncState.mode === 'directory') {
        // Mark the folder so future runs skip the legacy-vault guard.
        try { await ODP.sync.writeLocalFile(syncState.dirHandle, '.pwa-vault-root.json', ODP.sync.markerBytes()); } catch (e) {}
        await doScan();
      }
    } catch (e) {
      logError('Local sync failed', friendlyFsError(e));
    }
  }

  // Escape hatch: forget what the last sync thought the state was. Useful when
  // the plan looks wrong (e.g. it offers a pull for a file that was just pushed,
  // which would overwrite the local edit). Deletes nothing on either side.
  async function doResetBaseline() {
    if (!syncState.dirHandle) return;
    const ok = await confirmModal('Reset the sync baseline?',
      'Forgets what the last synchronised state was. Nothing is deleted from Drive or your folder, ' +
      'but the next scan re-derives everything from both sides and may report more differences. ' +
      'Use this when the plan looks wrong.');
    if (!ok) return;
    const doneOk = await ODP.sync.clearManifest(syncState.dirHandle.name);
    syncState.scan = null;
    $('#syncList').innerHTML = '';
    $('#syncSummary').textContent = '';
    $('#syncExecute').disabled = true;
    const prog = $('#syncProgress');
    prog.hidden = false;
    prog.textContent = doneOk
      ? 'Baseline cleared — run "Scan & Preview Sync" again to re-derive the state.'
      : 'Could not clear the baseline.';
    toast(doneOk ? 'Baseline cleared.' : 'Could not clear the baseline.');
  }

  async function doExportZip() {
    const prog = $('#syncProgress');
    prog.hidden = false;
    try {
      const blob = await ODP.sync.exportZip((i, n, p) => {
        prog.textContent = 'Exporting ' + i + '/' + n + '  ' + p;
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ObsidianVault-New ' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      prog.textContent = 'ZIP downloaded (' + Math.round(blob.size / 1024) + ' KB). ' +
        'Unzip it into your Obsidian vault folder on the device.';
    } catch (e) {
      logError('ZIP export failed', (e && e.message) || String(e));
    }
  }

  async function doImportZip(file) {
    const prog = $('#syncProgress');
    prog.hidden = false;
    try {
      const plan = await ODP.sync.importZip(file, (i, n, p) => {
        prog.textContent = 'Reading ZIP ' + i + '/' + n + '  ' + p;
      });
      syncState.mode = 'zip';
      syncState.scan = { plan };
      prog.textContent = 'Compared the ZIP against Drive — nothing uploaded yet.';
      renderPlan();
    } catch (e) {
      logError('ZIP import failed', (e && e.message) || String(e));
    }
  }

  // ---------------- boot ----------------
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      ODP.config.instanceId = await ODP.store.ensureInstanceId();
    } catch (e) {
      // Storage unavailable (private mode / non-secure context) — sandbox
      // still works; locks/sync simply won't persist this session.
      ODP.config.instanceId = 'i-' + Math.random().toString(36).slice(2, 10);
      state.storageOff = true;
    }
    wire();
    loadSandbox();
    showErrBar();   // restore any error logged before a reload
    // Resume a previous Drive session — silently, and only if the user has
    // connected before (or a still-valid token was saved). Never prompts here.
    if (!isLanIpOrigin() && ODP.auth.isConfigured()) {
      (async () => {
        let connected = localStorage.getItem('odp3Connected') === '1';
        if (!connected) {
          try {
            const saved = await ODP.store.getMeta('accessToken', null);
            connected = !!(saved && saved.value && Date.now() < saved.expiresAt - 30000);
          } catch (e) {}
        }
        if (connected) { localStorage.setItem('odp3Connected', '1'); resumeDrive(); }
      })();
    }
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch (e) {}
    }
  });

  // Called by DriveVaultService on a 401, before it retries with a fresh token.
  function sessionExpired() {
    const msg = 'Google session expired — re-authenticating… your draft is saved locally.';
    $('#stMsg').textContent = msg;
    toast(msg);
  }

  ODP.app = { state, openNote, toast, sessionExpired };
})();
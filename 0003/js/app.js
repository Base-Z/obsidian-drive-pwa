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
      badge.textContent = 'Active Vault: ' + (ODP.store.meta && localStorage.getItem('odp3RootName') || 'ObsidianVault-New');
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
      toast('Signed in. Loading vault…');
      await loadDrive();
    } catch (e) { toast(e.message || String(e), true); }
  }

  async function loadDrive() {
    const name = ODP.config.vaultFolderDefaultName;
    const root = await ODP.drive.ensureVaultRoot(name);
    localStorage.setItem('odp3RootName', name);
    let token = await ODP.store.getMeta('changesStartToken', null);
    if (!token) { token = await ODP.drive.getStartPageToken(); await ODP.store.meta.set('changesStartToken', token); }
    const files = await ODP.drive.buildTree(root.id);
    state.mode = 'drive';
    state.records = files;
    // Lazily fetch .md bodies for indexing/search/backlinks.
    const md = files.filter(f => /\.md$/i.test(f.path));
    await Promise.all(md.map(async f => { try { f.content = (await ODP.drive.getContent(f.id)).replace(/\r\n?/g, '\n'); } catch (e) {} }));
    ODP.VaultIndex.build(state.records);
    renderTree(); updateStatus(); updateAuthUi();
    if (!md.length) toast('New vault created — it has no notes yet.');
    else toast('Vault loaded: ' + md.length + ' notes.');
    const first = md[0];
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
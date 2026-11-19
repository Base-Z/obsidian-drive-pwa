/* ============================================================
   sync.js — LocalSyncEngine (spec §5.3)
   Explicit, user-triggered synchronisation between the Drive vault and a
   local Obsidian vault folder.

   Modes:
     • Directory sync  — File System Access API (`showDirectoryPicker`).
       Feature-detected, never user-agent sniffed, so Android Chrome 132+
       gets the same direct "Sync Now" as Linux/Windows.
     • ZIP bundle      — export/import fallback when the picker is missing
       or blocked (lockdown mode, Firefox, older Android).

   Design rules (spec, non-negotiable):
     • 3-way diff against a `local-sync-manifest.json` baseline.
     • CRLF-safe: raw MD5 fast path; on mismatch for text, normalise CRLF→LF
       and compare normalised SHA-256 before declaring a change.
     • Never overwrite: two-way collisions become side-by-side conflict copies.
     • Refuse to push a note locked by another device.
     • Hard exclusions (.obsidian/workspace*.json, .trash, .git, .stfolder).
     • Legacy-vault safety guard before the first run against a folder.

   Nothing here runs in the background — every transfer is user-triggered.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  // ---------- text detection ----------
  const TEXT_EXT = /\.(md|markdown|txt|json|css|js|csv|yml|yaml|svg|html?)$/i;
  const isTextPath = (p) => TEXT_EXT.test(p);

  // ---------- hashing ----------
  // WebCrypto has no MD5, but Drive reports md5Checksum, so the align-hashes
  // fast path needs MD5 (vendored spark-md5).
  function md5Hex(bytes) {
    return SparkMD5.ArrayBuffer.hash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  async function sha256Hex(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // CRLF -> LF (bytes, so we never mangle non-UTF8 content).
  function normaliseLF(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10) continue; // drop CR of CRLF
      out.push(bytes[i]);
    }
    return new Uint8Array(out);
  }
  async function hashBytes(bytes, path) {
    const h = { md5: md5Hex(bytes), size: bytes.length };
    if (isTextPath(path)) h.sha256Norm = await sha256Hex(normaliseLF(bytes));
    return h;
  }

  // ---------- feature detection (never UA sniffing) ----------
  function supportsDirectoryPicker() {
    return typeof window.showDirectoryPicker === 'function';
  }

  async function pickDirectory() {
    if (!supportsDirectoryPicker()) throw new Error('Directory picker not available');
    // mode:'readwrite' so we can pull changes down. Android refuses the root
    // of internal storage, so the UI asks for a dedicated subfolder.
    return window.showDirectoryPicker({ id: 'odp-vault', mode: 'readwrite', startIn: 'documents' });
  }

  // ---------- local filesystem adapter ----------
  async function readLocalTree(dirHandle) {
    const files = new Map();
    async function walk(dir, prefix) {
      for await (const [name, entry] of dir.entries()) {
        const rel = prefix ? prefix + '/' + name : name;
        if (ODP.config.isExcluded(rel)) continue;          // spec §4.2 exclusions
        if (entry.kind === 'directory') { await walk(entry, rel); continue; }
        try {
          const file = await entry.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          const h = await hashBytes(bytes, rel);
          files.set(rel, { rel, handle: entry, bytes, mtime: file.lastModified, hash: h });
        } catch (e) { /* unreadable entry — skip rather than abort the scan */ }
      }
    }
    await walk(dirHandle, '');
    return files;
  }

  async function ensureDir(root, relDir) {
    if (!relDir) return root;
    let dir = root;
    for (const part of relDir.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }
  async function writeLocalFile(root, rel, bytes) {
    const parts = rel.split('/');
    const dir = await ensureDir(root, parts.slice(0, -1).join('/'));
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }
  async function deleteLocalFile(root, rel) {
    const parts = rel.split('/');
    const dir = await ensureDir(root, parts.slice(0, -1).join('/'));
    try { await dir.removeEntry(parts[parts.length - 1]); } catch (e) {}
  }

  // ---------- manifest (baseline) ----------
  function manifestKey(dirName) {
    return (ODP.drive.rootVaultFolderId || 'vault') + ':' + (dirName || 'unnamed');
  }
  async function loadManifest(key) {
    try {
      const rec = await ODP.store.syncman.get(key);
      return (rec && rec.entries) ? rec.entries : null;
    } catch (e) { return null; }
  }
  async function saveManifest(key, entries) {
    try { await ODP.store.syncman.set({ id: key, entries, updatedAt: new Date().toISOString() }); }
    catch (e) { /* manifest is an optimisation; losing it causes a re-scan, not data loss */ }
  }

  // ---------- fetch a remote file's bytes (text files only, for CRLF checks) ----------
  async function remoteHash(rec, needNormalised) {
    const h = { md5: rec.md5Checksum || null };
    if (!needNormalised || !isTextPath(rec.path)) return h;
    try {
      const bytes = await ODP.drive.getBytes(rec.id);
      h.sha256Norm = await sha256Hex(normaliseLF(bytes));
    } catch (e) { /* leave undefined — caller falls back to raw comparison */ }
    return h;
  }

  // Does this side still match the baseline?
  function matchesBaseline(sideHash, base, path) {
    if (!sideHash || !base) return false;
    if (sideHash.md5 && base.rawMd5 && sideHash.md5 === base.rawMd5) return true;
    if (isTextPath(path) && sideHash.sha256Norm && base.normSha &&
        sideHash.sha256Norm === base.normSha) return true;   // CRLF-only drift
    return false;
  }

  // ---------- classification (pure — the heart of the 3-way diff) ----------
  // local:   Map<rel, {hash}>
  // remote:  Array<{id, path, md5Checksum, headRevisionId, properties, modifiedTime}>
  // baseline: Map<rel, {fileId, rawMd5, normSha, remoteMtime, localMtime}> | null
  function classify(local, remote, baseline, opts) {
    opts = opts || {};
    const plan = [];
    const remoteByPath = new Map(remote.map(r => [r.path, r]));
    const paths = new Set([...local.keys(), ...remoteByPath.keys(),
                           ...(baseline ? baseline.keys() : [])]);

    for (const path of [...paths].sort()) {
      const l = local.get(path);
      const r = remoteByPath.get(path);
      const b = baseline ? baseline.get(path) : undefined;

      // Never sync vault markers or excluded paths.
      if (ODP.config.isExcluded(path) || /(^|\/)\.pwa-vault-root\.json$/.test(path)) continue;

      const lockState = r ? ODP.LockManager.state(r) : 'AVAILABLE';
      const lockedByOther = lockState === 'LOCKED_BY_OTHER_DEVICE';

      // Brand new on both sides (first scan of this folder with no baseline).
      if (!b) {
        if (l && !r) { plan.push({ path, action: 'push', reason: 'New on local' }); continue; }
        if (r && !l) { plan.push({ path, action: 'pull', reason: 'New on remote' }); continue; }
        if (l && r) {
          if (matchesBaseline(l.hash, { rawMd5: r.md5Checksum, normSha: r.normSha }, path)) {
            plan.push({ path, action: 'none', reason: 'Identical' });
          } else {
            plan.push({ path, action: 'conflict', reason: 'Differs on both sides (no baseline)', remote: r, local: l });
          }
          continue;
        }
      }

      const localChanged = l ? !matchesBaseline(l.hash, b, path) : true;   // missing locally = changed
      const remoteChanged = r ? !matchesBaseline({ md5: r.md5Checksum, sha256Norm: r.sha256Norm }, b, path) : true;

      if (l && r && !localChanged && !remoteChanged) { plan.push({ path, action: 'none', reason: 'Unchanged' }); continue; }

      if (l && r) {
        if (!localChanged && remoteChanged) plan.push({ path, action: 'pull', reason: 'Remote updated', remote: r });
        else if (localChanged && !remoteChanged) plan.push({ path, action: 'push', reason: 'Local updated', remote: r, lockedByOther });
        else plan.push({ path, action: 'conflict', reason: 'Changed on both sides', remote: r, local: l });
        continue;
      }
      if (l && !r) {
        if (b && !localChanged) plan.push({ path, action: 'delete-remote', reason: 'Deleted on remote' });
        else plan.push({ path, action: 'push', reason: 'New or local-only' });
        continue;
      }
      if (!l && r) {
        if (b && !remoteChanged) plan.push({ path, action: 'delete-local', reason: 'Deleted locally' });
        else plan.push({ path, action: 'pull', reason: 'New or remote-only', remote: r });
      }
    }
    // Never auto-delete anything unless the caller explicitly allows it.
    if (!opts.allowDeletes) {
      for (const item of plan) {
        if (item.action === 'delete-remote' || item.action === 'delete-local') {
          item.action = 'none';
          item.reason += ' (deletion skipped — not enabled)';
        }
      }
    }
    return plan;
  }

  // ---------- legacy-vault safety guard (spec §4.2) ----------
  function legacyGuard(local, baseline, markerPresent) {
    if (baseline) return null;                    // we've synced here before
    if (markerPresent) return null;               // it's already marked as the new vault
    const noteCount = [...local.keys()].filter(p => /\.md$/i.test(p)).length;
    if (noteCount === 0) return null;             // empty/new folder — nothing to clobber
    return {
      noteCount,
      message: 'This folder already contains ' + noteCount + ' Markdown note(s) and is not marked as ' +
               'the new vault. Syncing here could overwrite an existing (e.g. legacy) vault.'
    };
  }

  function markerBytes() {
    return new TextEncoder().encode(JSON.stringify({
      vaultRole: 'new-deliverable',
      createdAt: new Date().toISOString()
    }, null, 2));
  }

  // ---------- conflict copies (spec: never overwrite) ----------
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + '-' + p(d.getMinutes());
  }
  function conflictName(path, side) {
    const i = path.lastIndexOf('/');
    const dir = i === -1 ? '' : path.slice(0, i + 1);
    const name = i === -1 ? path : path.slice(i + 1);
    const stem = name.replace(/\.[^.]+$/, '');
    const ext = name.slice(stem.length);
    return dir + stem + ' (' + side + ' Conflict ' + stamp() + ')' + ext;
  }

  // ---------- Drive helpers ----------
  async function remoteTree() {
    const all = await ODP.drive.buildTree(ODP.drive.rootVaultFolderId);
    const out = [];
    for (const rec of all) {
      if (/(^|\/)\.pwa-vault-root\.json$/.test(rec.path)) continue;
      out.push({ id: rec.id, path: rec.path, md5Checksum: rec.md5Checksum, name: rec.name,
                 mimeType: rec.mimeType, headRevisionId: rec.headRevisionId,
                 modifiedTime: rec.modifiedTime, properties: rec.properties || {} });
    }
    // Fill in normalised hashes only where the raw hash disagrees with the
    // baseline — CRLF-safety without downloading the whole vault.
    return out;
  }

  async function baselineNeedsRemoteNormalised(remote, baseline) {
    const need = [];
    for (const r of remote) {
      if (!isTextPath(r.path)) continue;
      const b = baseline && baseline.get(r.path);
      if (!b) continue;
      if (r.md5Checksum === b.rawMd5) continue;      // fast path: identical
      need.push(r);
    }
    return need;
  }

  async function buildBaselineMap(entries) {
    if (!entries) return null;
    const m = new Map();
    for (const [path, e] of Object.entries(entries)) m.set(path, e);
    return m;
  }

  // ---------- scan ----------
  async function scanDirectory(dirHandle, opts) {
    const key = manifestKey(dirHandle.name);
    const baselineEntries = await loadManifest(key);
    const baseline = await buildBaselineMap(baselineEntries);
    const local = await readLocalTree(dirHandle);

    const markerPresent = local.has('.pwa-vault-root.json');
    const guard = legacyGuard(local, baseline, markerPresent);
    if (guard && !(opts && opts.acceptedGuard)) {
      return { guard, key, dirName: dirHandle.name, local, baseline };
    }

    const remote = await remoteTree();
    for (const r of await baselineNeedsRemoteNormalised(remote, baseline)) {
      const h = await remoteHash(r, true);
      r.sha256Norm = h.sha256Norm;
    }
    const plan = classify(local, remote, baseline, opts || {});
    return { plan, key, dirName: dirHandle.name, local, baseline, remote, markerPresent };
  }

  // ---------- execute ----------
  async function executeDirectory(dirHandle, state, plan, onProgress) {
    const key = state.key;
    const baseline = state.baseline || new Map();
    const remote = state.remote || await remoteTree();
    const remoteByPath = new Map(remote.map(r => [r.path, r]));
    const local = state.local || new Map();
    const newEntries = {};
    for (const [p, e] of baseline) newEntries[p] = e;

    const items = plan.filter(p => p.selected && p.action !== 'none');
    let done = 0;
    const total = items.length;

    for (const item of items) {
      try {
        const path = item.path;
        if (item.action === 'pull') {
          const rec = remoteByPath.get(path) || item.remote;
          let bytes = await ODP.drive.getBytes(rec.id);
          if (isTextPath(path)) bytes = normaliseLF(bytes);   // write LF locally
          await writeLocalFile(dirHandle, path, bytes);
        } else if (item.action === 'push') {
          if (item.lockedByOther) { done++; onProgress && onProgress(done, total, item, 'skipped (locked)'); continue; }
          const l = local.get(path);
          if (!l) throw new Error('local file vanished');
          const rec = remoteByPath.get(path);
          const text = isTextPath(path) ? new TextDecoder().decode(normaliseLF(l.bytes)) : l.bytes;
          if (rec) await ODP.drive.updateFile(rec.id, text);
          else {
            const parent = await parentIdFor(path);
            await ODP.drive.createFile(path.split('/').pop(), parent,
              text, isTextPath(path) ? 'text/markdown' : 'application/octet-stream');
          }
        } else if (item.action === 'conflict') {
          // Never overwrite: keep both, side by side.
          const rec = remoteByPath.get(path);
          const l = local.get(path);
          if (l) {
            const parent = rec ? (rec.parents && rec.parents[0]) || await parentIdFor(path) : await parentIdFor(path);
            await ODP.drive.createFile(conflictName(path, 'Local').split('/').pop(), parent,
              new TextDecoder().decode(normaliseLF(l.bytes)));
          }
          if (rec) {
            let bytes = await ODP.drive.getBytes(rec.id);
            if (isTextPath(path)) bytes = normaliseLF(bytes);
            await writeLocalFile(dirHandle, conflictName(path, 'Remote'), bytes);
          }
        }
        onProgress && onProgress(++done, total, item, 'done');
      } catch (e) {
        onProgress && onProgress(++done, total, item, 'error: ' + (e.message || e));
      }
    }

    // Refresh the baseline from what is now on both sides.
    const after = await readLocalTree(dirHandle);
    const remoteAfter = await remoteTree();
    const remoteAfterByPath = new Map(remoteAfter.map(r => [r.path, r]));
    for (const path of new Set([...after.keys(), ...remoteAfterByPath.keys()])) {
      if (ODP.config.isExcluded(path)) continue;
      const l = after.get(path);
      const r = remoteAfterByPath.get(path);
      if (!l && !r) { delete newEntries[path]; continue; }
      newEntries[path] = {
        fileId: r ? r.id : null,
        rawMd5: l ? l.hash.md5 : (r ? r.md5Checksum : null),
        normSha: l ? l.hash.sha256Norm : undefined,
        remoteMtime: r ? r.modifiedTime : null,
        localMtime: l ? l.mtime : null
      };
    }
    await saveManifest(key, newEntries);
    return { done, total };
  }

  // Resolve (creating if needed) the Drive folder id for a vault-relative path,
  // so pushing `Notes/New.md` lands in Notes/ rather than the vault root.
  async function parentIdFor(relPath) {
    const dir = relPath.split('/').slice(0, -1).join('/');
    if (!dir) return ODP.drive.rootVaultFolderId;
    let parent = ODP.drive.rootVaultFolderId;
    for (const seg of dir.split('/')) {
      const found = await ODP.drive.findFolder(parent, seg);
      parent = found ? found.id : (await ODP.drive.createFolder(seg, parent)).id;
    }
    return parent;
  }

  // ---------- ZIP fallback ----------
  async function exportZip(onProgress) {
    const remote = await remoteTree();
    const zipped = {};
    let i = 0;
    for (const rec of remote) {
      try {
        const bytes = await ODP.drive.getBytes(rec.id);
        zipped[rec.path] = bytes;
      } catch (e) { /* skip unreadable */ }
      onProgress && onProgress(++i, remote.length, rec.path);
    }
    // Marker so a later import can tell this is the new vault.
    zipped['.pwa-vault-root.json'] = markerBytes();
    const out = fflate.zipSync(zipped, { level: 6 });
    return new Blob([out], { type: 'application/zip' });
  }

  async function importZip(file, onProgress) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const entries = fflate.unzipSync(buf);
    const remote = await remoteTree();
    const remoteByPath = new Map(remote.map(r => [r.path, r]));
    const plan = [];
    const names = Object.keys(entries);
    let i = 0;
    for (const path of names) {
      if (ODP.config.isExcluded(path) || /(^|\/)\.pwa-vault-root\.json$/.test(path)) { onProgress && onProgress(++i, names.length, path); continue; }
      const bytes = entries[path];
      const h = await hashBytes(bytes, path);
      const rec = remoteByPath.get(path);
      if (rec && rec.md5Checksum === h.md5) {
        plan.push({ path, action: 'none', reason: 'Identical' });
      } else {
        const lockedByOther = rec && ODP.LockManager.state(rec) === 'LOCKED_BY_OTHER_DEVICE';
        plan.push({ path, action: rec ? 'push' : 'push', reason: rec ? 'Differs — behind upload' : 'New', bytes, lockedByOther, remote: rec });
      }
      onProgress && onProgress(++i, names.length, path);
    }
    return plan;
  }

  async function executeImport(plan, onProgress) {
    const items = plan.filter(p => p.selected && p.action !== 'none');
    let done = 0;
    for (const item of items) {
      try {
        if (item.lockedByOther) { onProgress && onProgress(++done, items.length, item.path, 'skipped (locked)'); continue; }
        const text = isTextPath(item.path) ? new TextDecoder().decode(normaliseLF(item.bytes)) : item.bytes;
        if (item.remote) await ODP.drive.updateFile(item.remote.id, text);
        else await ODP.drive.createFile(item.path.split('/').pop(), await parentIdFor(item.path), text,
                                        isTextPath(item.path) ? 'text/markdown' : 'application/octet-stream');
        onProgress && onProgress(++done, items.length, item.path, 'done');
      } catch (e) {
        onProgress && onProgress(++done, items.length, item.path, 'error: ' + (e.message || e));
      }
    }
    return { done, total: items.length };
  }

  ODP.sync = {
    supportsDirectoryPicker,
    pickDirectory,
    readLocalTree,
    writeLocalFile,
    deleteLocalFile,
    scanDirectory,
    executeDirectory,
    exportZip,
    importZip,
    executeImport,
    classify,
    hashBytes,
    normaliseLF,
    md5Hex,
    isTextPath,
    manifestKey,
    loadManifest,
    saveManifest,
    conflictName,
    markerBytes
  };
})();

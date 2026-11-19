/* ============================================================
   drive.js — DriveVaultService (spec §3.2 module 2, §4.2, §8.1)
   Google Drive REST API v3 wrapper with:
     • Vault Root Jail  — assertWithinActiveVaultRoot(fileId) must pass
       before ANY write/lock/rename/delete.
     • Concurrent BFS tree builder (initial load) + Changes API delta.
     • Exponential backoff w/ jitter on 429/503.
     • .md multipart upload with LF normalisation.
   Nothing here is exercised until a Google OAuth client id is supplied.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FIELDS = 'nextPageToken, files(id, name, mimeType, parents, modifiedTime, md5Checksum, headRevisionId, trashed, properties)';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const Drive = {
    rootVaultFolderId: null,

    async _fetch(url, opts = {}, attempt = 0) {
      const token = await ODP.auth.ensureToken();
      const headers = Object.assign({}, opts.headers || {});
      headers['Authorization'] = 'Bearer ' + token;
      let res;
      try {
        res = await fetch(url, Object.assign({}, opts, { headers }));
      } catch (e) {
        if (attempt < 3) { await sleep((2 ** attempt) * 400 + Math.random() * 300); return this._fetch(url, opts, attempt + 1); }
        throw e;
      }
      if (res.status === 401) {
        // Access token expired (GIS tokens last ~1 hour; in Testing mode the
        // grant itself can lapse after ~7 days). Clear it and retry once
        // after silent renewal — signIn() prompts only if silence is
        // impossible. Any unsaved edit is safe: it is autosaved to IndexedDB.
        ODP.auth.accessToken = null;
        try { ODP.store.meta.del('accessToken'); } catch (e) {}
        if (ODP.app && ODP.app.sessionExpired) ODP.app.sessionExpired();
        if (attempt < 1) return this._fetch(url, opts, attempt + 1);
        throw new Error('unauthorized');
      }
      if (res.status === 429 || res.status === 503) {
        if (attempt < 5) { await sleep((2 ** attempt) * 500 + Math.random() * 400); return this._fetch(url, opts, attempt + 1); }
      }
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error.message; } catch (e) {}
        throw new Error('Drive ' + res.status + (detail ? ': ' + detail : ''));
      }
      return res;
    },

    async _json(url, opts) { return (await this._fetch(url, opts)).json(); },

    // ── Vault Root Jail (spec §4.1) ─────────────────────────────
    async assertWithinActiveVaultRoot(fileId) {
      if (!this.rootVaultFolderId) throw new Error('No active vault root set.');
      if (fileId === this.rootVaultFolderId) return true;
      let cur = fileId;
      const seen = new Set();
      for (let depth = 0; depth < 64; depth++) {
        if (!cur || seen.has(cur)) break;
        seen.add(cur);
        const meta = await this._json(`${API}/files/${cur}?fields=id,parents`);
        if (!meta.parents || !meta.parents.length) break;
        for (const p of meta.parents) {
          if (p === this.rootVaultFolderId) return true;
        }
        cur = meta.parents[0];
      }
      throw new Error('Vault Root Jail: file ' + fileId + ' is outside the active vault root.');
    },

    // ── Folders / tree ──────────────────────────────────────────
    async listChildren(folderId, pageToken) {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      let url = `${API}/files?q=${q}&pageSize=1000&fields=${encodeURIComponent(FIELDS)}`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this._json(url);
      return { files: (data.files || []).filter(f => !ODP.config.isExcluded(f.name)), nextPageToken: data.nextPageToken };
    },

    // Concurrent BFS (concurrency limit 6) — build a flat record list.
    async buildTree(rootId) {
      const out = [];
      const queue = [{ id: rootId, relPath: '' }];
      const CONC = 6;
      while (queue.length) {
        const batch = queue.splice(0, CONC);
        const results = await Promise.all(batch.map(async (node) => {
          const files = [];
          let token;
          do {
            const page = await this.listChildren(node.id, token);
            files.push(...page.files);
            token = page.nextPageToken;
          } while (token);
          return { node, files };
        }));
        for (const { node, files } of results) {
          for (const f of files) {
            const rel = node.relPath ? node.relPath + '/' + f.name : f.name;
            if (f.mimeType === 'application/vnd.google-apps.folder') {
              queue.push({ id: f.id, relPath: rel });
            } else if (!ODP.config.isExcluded(rel)) {
              out.push(Object.assign({}, f, { path: rel }));
            }
          }
        }
      }
      return out;
    },

    // ── Changes API (incremental refresh, §8.1) ─────────────────
    async getStartPageToken() {
      const d = await this._json(`${API}/changes/startPageToken`);
      return d.startPageToken;
    },
    async listChanges(pageToken) {
      const d = await this._json(`${API}/changes?pageToken=${encodeURIComponent(pageToken)}&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS.replace('nextPageToken, files(', '').replace(/\)$/, '')}))`);
      return d;
    },

    async getMeta(fileId) {
      return this._json(`${API}/files/${fileId}?fields=id,name,mimeType,parents,modifiedTime,md5Checksum,headRevisionId,properties`);
    },
    async getContent(fileId) {
      const res = await this._fetch(`${API}/files/${fileId}?alt=media`);
      return res.text();
    },
    async getBlob(fileId) {
      const res = await this._fetch(`${API}/files/${fileId}?alt=media`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },

    // ── Vault root creation (spec §4.2) ─────────────────────────
    async createFolder(name, parentId) {
      const body = { name, mimeType: 'application/vnd.google-apps.folder' };
      if (parentId) body.parents = [parentId];
      return this._json(`${API}/files?fields=id,name`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    },
    async findVaultRoot(name) {
      const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`);
      const d = await this._json(`${API}/files?q=${q}&fields=files(id,name)`);
      return d.files && d.files[0] ? d.files[0] : null;
    },
    async ensureVaultRoot(name) {
      let root = await this.findVaultRoot(name);
      if (!root) root = await this.createFolder(name, 'root');
      this.rootVaultFolderId = root.id;
      await ODP.store.meta.set('rootVaultFolderId', root.id);
      await ODP.store.meta.set('rootVaultName', name);
      // Write the marker file if absent.
      await this.writeMarker(root.id);
      return root;
    },
    async writeMarker(rootId) {
      const q = encodeURIComponent(`name = '${ODP.config.rootMarkerFile}' and '${rootId}' in parents and trashed = false`);
      const d = await this._json(`${API}/files?q=${q}&fields=files(id)`);
      if (d.files && d.files.length) return d.files[0].id;
      const content = JSON.stringify({ vaultRole: 'new-deliverable', createdAt: new Date().toISOString() }, null, 2);
      const created = await this.createFile(ODP.config.rootMarkerFile, rootId, content, 'application/json');
      return created.id;
    },

    // ── Create / upload ─────────────────────────────────────────
    async createFile(name, parentId, content, mimeType) {
      const metadata = { name, parents: parentId ? [parentId] : undefined, mimeType: mimeType || 'text/markdown' };
      return this._multipart(null, metadata, content);
    },
    // PATCH content (+ optional properties change, e.g. clearing the lock).
    async updateFile(fileId, content, properties) {
      const metadata = {};
      if (properties) metadata.properties = properties;
      return this._multipart(fileId, metadata, content);
    },
    async _multipart(fileId, metadata, content) {
      const boundary = 'odb-' + Math.random().toString(36).slice(2);
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n` +
        content +
        `\r\n--${boundary}--`;
      const url = fileId
        ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,headRevisionId,md5Checksum,properties`
        : `${UPLOAD}/files?uploadType=multipart&fields=id,headRevisionId,md5Checksum,properties`;
      const res = await this._fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body
      });
      return res.json();
    },
    // Lock metadata only (no content change).
    async patchProperties(fileId, properties) {
      const res = await this._fetch(`${API}/files/${fileId}?fields=id,headRevisionId,properties`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties })
      });
      return res.json();
    },
    async rename(fileId, name) {
      return this._json(`${API}/files/${fileId}?fields=id,name`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
    },
    async trash(fileId) {
      return this._json(`${API}/files/${fileId}?fields=id,trashed`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
      });
    },
    async deleteFile(fileId) {
      await this._fetch(`${API}/files/${fileId}`, { method: 'DELETE' });
      return true;
    }
  };

  ODP.drive = Drive;
})();

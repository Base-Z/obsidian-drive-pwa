/* ============================================================
   store.js — IndexedDB layer for project 0003
   Stores:
     meta     (key -> value)   app settings, rootVaultFolderId, pageToken, instanceId
     notes    (id  -> record)  cached .md metadata + content
     drafts   (id  -> record)  pending check-in drafts (offline edits)
     handles  (key -> handle)  File System Access API directory handles
     syncman  (vaultId -> rec) local-sync-manifest.json contents
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const DB_NAME = 'odp3';
  const DB_VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
        if (!db.objectStoreNames.contains('syncman')) db.createObjectStore('syncman');
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const wrap = (name, key) => ({
    get: (k) => tx(name, 'readonly', s => s.get(k)),
    set: (k, v) => tx(name, 'readwrite', s => s.put(v, k)),
    del: (k) => tx(name, 'readwrite', s => s.delete(k)),
    all: () => tx(name, 'readonly', s => s.getAll()),
    clear: () => tx(name, 'readwrite', s => s.clear())
  });

  ODP.store = {
    meta: wrap('meta'),
    notes: wrap('notes'),
    drafts: wrap('drafts'),
    handles: wrap('handles'),
    syncman: wrap('syncman'),

    async getMeta(k, dflt) {
      const v = await this.meta.get(k);
      return v === undefined ? dflt : v;
    },
    async ensureInstanceId() {
      let id = await this.getMeta('instanceId', null);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
             ('i-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
        await this.meta.set('instanceId', id);
      }
      return id;
    },
    // Replace the whole cached note collection atomically-ish.
    async putNotes(records) {
      await tx('notes', 'readwrite', s => { records.forEach(r => s.put(r)); });
    },
    async clearNotes() { return this.notes.clear(); }
  };
})();

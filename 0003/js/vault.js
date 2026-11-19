/* ============================================================
   vault.js — VaultIndexEngine (spec §3.2 module 4, §8.5)
   In-memory graph over note records:
     { id, name, path, mimeType, content?, modifiedTime? }
   Provides: folder tree, wikilink resolution (Obsidian shortest-path,
   case-insensitive), backlinks, tag index, and full-text search.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  function dirname(p) { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
  function basename(p) { const i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }
  function stem(p) { return basename(p).replace(/\.md$/i, ''); }

  const VaultIndex = {
    notes: [],           // array of records
    byPath: new Map(),   // path -> record
    byName: new Map(),   // lowercased filename (with ext) -> [records]
    byStem: new Map(),   // lowercased stem -> [records]
    backlinkMap: new Map(), // target path -> Set(source path)
    tagMap: new Map(),   // tag -> Set(path)

    build(records) {
      this.notes = records.slice();
      this.byPath.clear(); this.byName.clear(); this.byStem.clear();
      this.backlinkMap.clear(); this.tagMap.clear();

      for (const r of this.notes) {
        this.byPath.set(r.path, r);
        const ln = r.name.toLowerCase();
        if (!this.byName.has(ln)) this.byName.set(ln, []);
        this.byName.get(ln).push(r);
        if (/\.md$/i.test(r.path)) {
          const ls = stem(r.path).toLowerCase();
          if (!this.byStem.has(ls)) this.byStem.set(ls, []);
          this.byStem.get(ls).push(r);
        }
      }
      this._buildGraph();
    },

    _buildGraph() {
      for (const r of this.notes) {
        if (!/\.md$/i.test(r.path) || typeof r.content !== 'string') continue;
        const { links, tags } = ODP.md.render(r.content, {});
        for (const t of tags) {
          if (!this.tagMap.has(t)) this.tagMap.set(t, new Set());
          this.tagMap.get(t).add(r.path);
        }
        for (const target of links) {
          const hit = this.resolveWikilink(target, null, r.path);
          if (hit && hit.exists) {
            if (!this.backlinkMap.has(hit.path)) this.backlinkMap.set(hit.path, new Set());
            this.backlinkMap.get(hit.path).add(r.path);
          }
        }
      }
    },

    // Obsidian-style resolution: exact relative path first, then unique
    // filename match; case-insensitive everywhere.
    resolveWikilink(target, heading, fromPath) {
      if (!target) return { exists: false, href: '#' };
      let t = target.replace(/^\.\//, '').trim();
      const withExt = /\.\w{1,6}$/.test(t) ? t : t + '.md';
      const tLow = withExt.toLowerCase();

      // 1. Relative to the current note's folder, then from vault root.
      const candidates = [];
      const fromDir = dirname(fromPath || '');
      if (fromDir) candidates.push(fromDir + '/' + withExt);
      candidates.push(withExt);

      for (const c of candidates) {
        for (const [path, rec] of this.byPath) {
          if (path.toLowerCase() === c.toLowerCase()) return this._hit(rec, heading);
        }
      }
      // 2. Unique filename match anywhere in the vault.
      const byName = this.byName.get(basename(withExt).toLowerCase()) || [];
      if (byName.length === 1) return this._hit(byName[0], heading);
      const byStem = this.byStem.get(t.toLowerCase()) || [];
      if (byStem.length === 1) return this._hit(byStem[0], heading);
      // 3. Ambiguous or missing.
      return { exists: false, href: '#', ambiguous: byName.length > 1 || byStem.length > 1, target };
    },

    _hit(rec, heading) {
      const h = heading ? '#h-' + String(heading).replace(/[^\w\u00C0-\uFFFF]+/g, '-').replace(/^-|-$/g, '').toLowerCase() : '';
      return { exists: true, href: '#' + encodeURIComponent(rec.path) + h, path: rec.path, record: rec };
    },

    backlinks(path) {
      const set = this.backlinkMap.get(path);
      return set ? [...set].map(p => this.byPath.get(p)).filter(Boolean) : [];
    },

    outgoing(path) {
      const rec = this.byPath.get(path);
      if (!rec || typeof rec.content !== 'string') return [];
      const { links } = ODP.md.render(rec.content, {});
      return links.map(t => ({ target: t, hit: this.resolveWikilink(t, null, path) }));
    },

    noteTitles() {
      return this.notes.filter(r => /\.md$/i.test(r.path))
        .map(r => ({ path: r.path, title: stem(r.path) }));
    },

    // Fuzzy-ish quick switcher (subsequence match on the title).
    quickSwitch(q) {
      const query = (q || '').toLowerCase().trim();
      const titles = this.noteTitles();
      if (!query) return titles.slice(0, 50);
      const score = (title) => {
        const t = title.toLowerCase();
        if (t.includes(query)) return 1000 - t.indexOf(query);
        let ti = 0, qi = 0, s = 0;
        while (ti < t.length && qi < query.length) {
          if (t[ti] === query[qi]) { s += 1; qi++; }
          ti++;
        }
        return qi === query.length ? s : -1;
      };
      return titles.map(x => ({ ...x, _s: score(x.title) }))
        .filter(x => x._s >= 0)
        .sort((a, b) => b._s - a._s)
        .slice(0, 50);
    },

    // Full-text search across cached bodies + frontmatter tags.
    search(q) {
      const query = (q || '').toLowerCase().trim();
      if (!query) return [];
      const results = [];
      for (const r of this.notes) {
        if (typeof r.content !== 'string') continue;
        const hay = r.content.toLowerCase();
        const idx = hay.indexOf(query);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 40);
        results.push({
          path: r.path,
          title: stem(r.path),
          snippet: (start > 0 ? '…' : '') + r.content.slice(start, idx + query.length + 60).replace(/\s+/g, ' ') + '…'
        });
      }
      return results.slice(0, 100);
    },

    tags() {
      return [...this.tagMap.keys()].sort();
    },

    // Nested {folders, files} tree, folders before files, alphabetical.
    tree() {
      const root = { name: '', path: '', folders: new Map(), files: [] };
      for (const r of this.notes) {
        const parts = r.path.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          if (!node.folders.has(seg)) node.folders.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), folders: new Map(), files: [] });
          node = node.folders.get(seg);
        }
        node.files.push(r);
      }
      const finalize = (n) => ({
        name: n.name, path: n.path,
        folders: [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(finalize),
        files: n.files.sort((a, b) => a.name.localeCompare(b.name))
      });
      return finalize(root);
    }
  };

  ODP.VaultIndex = VaultIndex;
  ODP.paths = { dirname, basename, stem };
})();

/* ============================================================
   markdown.js — Obsidian-flavoured Markdown renderer (spec §5.2)
   No external dependency (KaTeX is optional and vendored locally).

   Supports: YAML frontmatter, headings, bold/italic/strike, inline
   code, fenced code, blockquotes, callouts (> [!note] etc.), ordered/
   unordered lists, interactive task lists, tables, horizontal rules,
   links, images, [[wikilinks]] (+ |alias and #heading), ![[embeds]],
   #tags / #nested/tags, and $inline$ / $$block$$ LaTeX via KaTeX.

   Renders to an HTML string. Never trusts note content as HTML.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

  // Pull a leading YAML frontmatter block off the source.
  function splitFrontmatter(src) {
    const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(src || '');
    if (!m) return { frontmatter: null, body: src || '' };
    return { frontmatter: m[1], body: (src || '').slice(m[0].length) };
  }

  // Tiny YAML subset -> array of {key, value}. Enough for Obsidian
  // property pills (scalars, inline lists, block lists).
  function parseYaml(yaml) {
    const out = [];
    const lines = (yaml || '').split(/\r?\n/);
    let cur = null;
    for (const line of lines) {
      const ml = /^\s*-\s+(.*)$/.exec(line);
      if (ml && cur) { cur.value += (cur.value ? ', ' : '') + ml[1].trim(); continue; }
      const kv = /^([A-Za-z0-9_\- .]+?):\s*(.*)$/.exec(line);
      if (!kv) continue;
      if (cur) out.push(cur);
      cur = { key: kv[1].trim(), value: kv[2].trim() };
      if (/^\[.*\]$/.test(cur.value)) cur.value = cur.value.slice(1, -1);
    }
    if (cur) out.push(cur);
    return out.map(p => ({ key: p.key, value: p.value.replace(/^["']|["']$/g, '') }));
  }

  // ---------- inline ----------
  function renderInline(text, ctx) {
    ctx = ctx || {};
    const prot = [];
    const stash = (html) => { prot.push(html); return '\uE000' + (prot.length - 1) + '\uE001'; };

    let s = text;

    // 1. Inline code — protect from all further processing.
    s = s.replace(/`([^`]+)`/g, (_, code) => stash('<code>' + esc(code) + '</code>'));

    // 2. Block math $$...$$ (should be handled at block level, keep here as fallback)
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(renderMath(tex, true)));
    // 3. Inline math $...$
    s = s.replace(/\$([^$\n]+?)\$/g, (_, tex) => stash(renderMath(tex, false)));

    // 4. Embeds ![[ ... ]]  (images / notes)
    s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, inner) => {
      const { target, alias, heading } = parseWikilink(inner);
      return stash(renderEmbed(target, alias, heading, ctx));
    });

    // 5. Markdown images ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, alt, url, title) => stash(`<img src="${escAttr(url)}" alt="${escAttr(alt)}"${title ? ` title="${escAttr(title)}"` : ''} loading="lazy">`));

    // 6. Wikilinks [[ ... ]]
    s = s.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
      const { target, alias, heading } = parseWikilink(inner);
      return stash(renderWikilink(target, alias, heading, ctx));
    });

    // 7. Markdown links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url) =>
      stash(`<a href="${escAttr(url)}" target="_blank" rel="noopener">${esc(label)}</a>`));

    // 8. Tags  #tag / #nested/tag  (not inside words, not a heading)
    s = s.replace(/(^|[\s(])#([A-Za-z0-9_\-/]+)(?=[\s.,;:)]|$)/g,
      (_, pre, tag) => pre + stash(`<a class="tag" href="#" data-tag="${escAttr(tag)}">#${esc(tag)}</a>`));

    // Escape whatever raw text remains.
    s = esc(s);
    // Re-escape the text inside stash placeholders? No — placeholders are
    // pure \uE000 N \uE001 and survive esc() untouched.

    // 9. Emphasis
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // Highlight ==text==
    s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    // 10. Restore protected fragments.
    s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => prot[+i]);
    return s;
  }

  function renderMath(tex, display) {
    const k = window.katex;
    if (k && typeof k.renderToString === 'function') {
      try { return k.renderToString(tex.trim(), { throwOnError: false, displayMode: !!display }); }
      catch (e) { /* fall through */ }
    }
    return `<span class="math${display ? ' math-block' : ''}">${esc((display ? '$$' : '$') + tex + (display ? '$$' : '$'))}</span>`;
  }

  function parseWikilink(inner) {
    let target = inner, alias = null, heading = null;
    const bar = inner.indexOf('|');
    if (bar !== -1) { target = inner.slice(0, bar); alias = inner.slice(bar + 1); }
    const hash = target.indexOf('#');
    if (hash !== -1) { heading = target.slice(hash + 1); target = target.slice(0, hash); }
    return { target: target.trim(), alias: alias ? alias.trim() : null, heading: (heading || '').trim() || null };
  }

  function renderWikilink(target, alias, heading, ctx) {
    const label = alias || target + (heading ? '#' + heading : '');
    let href = '#', missing = false;
    if (ctx.resolveWikilink) {
      const r = ctx.resolveWikilink(target, heading);
      missing = !r || !r.exists;
      if (r && r.href) href = r.href;
    }
    const cls = 'wikilink' + (missing ? ' missing' : '');
    const data = ` data-wikilink="${escAttr(target)}"${heading ? ` data-heading="${escAttr(heading)}"` : ''}`;
    return `<a class="${cls}" href="${escAttr(href)}"${data}>${esc(label)}</a>`;
  }

  function renderEmbed(target, alias, heading, ctx) {
    if (ctx.resolveEmbed) {
      const r = ctx.resolveEmbed(target, heading);
      if (r && r.type === 'image' && r.url) {
        return `<img class="embed" src="${escAttr(r.url)}" alt="${escAttr(alias || target)}" loading="lazy">`;
      }
      if (r && r.type === 'audio' && r.url) return `<audio controls src="${escAttr(r.url)}"></audio>`;
      if (r && r.type === 'note' && r.html != null) return `<div class="embed-note">${r.html}</div>`;
    }
    return renderWikilink(target, alias || ('!' + target), heading, ctx);
  }

  // ---------- blocks ----------
  function render(src, ctx) {
    ctx = ctx || {};
    const { frontmatter, body } = splitFrontmatter(src);
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const tags = new Set();
    const links = new Set();
    let i = 0;

    const collectTags = (t) => {
      t.replace(/(^|[\s(])#([A-Za-z0-9_\-/]+)(?=[\s.,;:)]|$)/g, (_, p, tag) => { tags.add(tag); return _; });
    };
    const collectLinks = (t) => {
      t.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => { links.add(parseWikilink(inner).target); return _; });
    };

    if (frontmatter != null) {
      const props = parseYaml(frontmatter);
      if (props.length) {
        out.push('<div class="frontmatter">' + props.map(p =>
          `<span class="prop"><span class="prop-k">${esc(p.key)}</span><span class="prop-v">${esc(p.value)}</span></span>`
        ).join('') + '</div>');
        props.forEach(p => collectTags(String(p.value)));
      }
    }

    while (i < lines.length) {
      let line = lines[i];

      // Blank
      if (/^\s*$/.test(line)) { i++; continue; }

      // Fenced code
      const fence = /^\s*(```|~~~)\s*([\w+\-.#]*)\s*$/.exec(line);
      if (fence) {
        const marker = fence[1], lang = fence[2] || '';
        const buf = []; i++;
        while (i < lines.length && !new RegExp('^\\s*' + marker).test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        out.push(`<pre class="code"><code${lang ? ` class="language-${escAttr(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // Heading
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const lvl = h[1].length, txt = h[2];
        collectTags(txt); collectLinks(txt);
        const id = 'h-' + txt.replace(/[^\w\u00C0-\uFFFF]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
        out.push(`<h${lvl} id="${escAttr(id)}">${renderInline(txt, ctx)}</h${lvl}>`);
        i++; continue;
      }

      // Horizontal rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Block math  $$ … $$  (multi-line, fenced by a bare $$ line)
      if (/^\s*\$\$\s*$/.test(line)) {
        const buf = []; i++;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing $$
        out.push('<div class="math-block">' + renderMath(buf.join('\n'), true) + '</div>');
        continue;
      }

      // Blockquote / callout
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(renderBlockquote(buf, ctx, collectTags, collectLinks));
        continue;
      }

      // Table
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        out.push(renderTable(buf, ctx));
        continue;
      }

      // Task list / unordered list
      if (/^\s*([-*+])\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) { buf.push(lines[i]); i++; }
        out.push(renderList(buf, ctx, false, collectTags, collectLinks));
        continue;
      }
      // Ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push(lines[i]); i++; }
        out.push(renderList(buf, ctx, true, collectTags, collectLinks));
        continue;
      }

      // Paragraph (gather consecutive non-blank, non-block lines)
      const para = [line];
      collectTags(line); collectLinks(line);
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^\s*(#{1,6}\s|>|```|~~~|\||[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
        collectTags(lines[i]); collectLinks(lines[i]);
        para.push(lines[i]); i++;
      }
      out.push('<p>' + para.map(l => renderInline(l, ctx)).join('<br>') + '</p>');
    }

    return { html: out.join('\n'), tags: [...tags], links: [...links] };
  }

  function renderBlockquote(buf, ctx, ct, cl) {
    // Callout?  first line like: [!note] Title
    const co = /^\[!(\w+)\]([+-])?\s*(.*)$/.exec(buf[0] || '');
    if (co) {
      const type = co[1].toLowerCase();
      const title = co[3] || (type.charAt(0).toUpperCase() + type.slice(1));
      const rest = buf.slice(1);
      rest.forEach(l => { ct(l); cl(l); });
      const inner = rest.map(l => renderInline(l, ctx)).join('<br>');
      return `<div class="callout callout-${escAttr(type)}">` +
             `<div class="callout-title"><span class="callout-ico"></span>${esc(title)}</div>` +
             `<div class="callout-body">${inner}</div></div>`;
    }
    buf.forEach(l => { ct(l); cl(l); });
    return '<blockquote>' + buf.map(l => renderInline(l, ctx)).join('<br>') + '</blockquote>';
  }

  function renderTable(buf, ctx) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(buf[0]);
    const rows = buf.slice(2).map(cells);
    let html = '<table><thead><tr>' + head.map(c => `<th>${renderInline(c, ctx)}</th>`).join('') + '</tr></thead><tbody>';
    for (const r of rows) html += '<tr>' + r.map(c => `<td>${renderInline(c, ctx)}</td>`).join('') + '</tr>';
    return html + '</tbody></table>';
  }

  function renderList(buf, ctx, ordered, ct, cl) {
    let html = ordered ? '<ol>' : '<ul>';
    let openTask = false;
    for (const raw of buf) {
      const li = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
      ct(li); cl(li);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li);
      if (task) {
        const checked = task[1].toLowerCase() === 'x';
        html += `<li class="task"><label><input type="checkbox" data-task ${checked ? 'checked' : ''}>` +
                `<span class="task-text${checked ? ' done' : ''}">${renderInline(task[2], ctx)}</span></label></li>`;
        openTask = true;
      } else {
        html += `<li${openTask ? '' : ''}>${renderInline(li, ctx)}</li>`;
      }
    }
    return html + (ordered ? '</ol>' : '</ul>');
  }

  // Frontmatter HTML alone (for the reading-view property pills).
  function frontmatterHtml(src) {
    const { frontmatter } = splitFrontmatter(src);
    if (frontmatter == null) return '';
    const props = parseYaml(frontmatter);
    if (!props.length) return '';
    return '<div class="frontmatter">' + props.map(p =>
      `<span class="prop"><span class="prop-k">${esc(p.key)}</span><span class="prop-v">${esc(p.value)}</span></span>`
    ).join('') + '</div>';
  }

  ODP.md = { render, renderInline, splitFrontmatter, parseYaml, frontmatterHtml, esc };
})();

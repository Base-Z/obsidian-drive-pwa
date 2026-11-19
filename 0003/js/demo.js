/* ============================================================
   demo.js — Sandbox vault (spec §2.4 "starter test notes")
   Bundled so the app is fully usable and testable BEFORE a Google
   OAuth client id exists, and so the renderer can be verified
   offline. Exercises: YAML frontmatter, [[wikilinks]] (+ alias and
   #heading), ![[embeds]], #tags / #nested/tags, callouts, task lists,
   tables, fenced code, and $LaTeX$.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200" viewBox="0 0 360 200">' +
    '<rect width="360" height="200" rx="14" fill="#161b2e"/>' +
    '<circle cx="96" cy="100" r="46" fill="none" stroke="#7c8bff" stroke-width="6"/>' +
    '<circle cx="264" cy="100" r="46" fill="none" stroke="#3ad6b0" stroke-width="6"/>' +
    '<path d="M120 100h120" stroke="#e6e9f5" stroke-width="4" stroke-dasharray="8 8"/>' +
    '<text x="180" y="40" fill="#9aa4c7" font-family="sans-serif" font-size="16" text-anchor="middle">attachments resolve by name</text>' +
    '</svg>');

  const NOTES = [
    {
      path: 'Welcome.md',
      content:
`---
title: Welcome to Obsidian Drive
tags: [sandbox, start-here]
created: 2026-11-19
---

# Welcome 👋

This is a **sandbox vault** bundled with the app so it works before you sign in to
Google Drive. Everything here renders exactly as it would from Drive.

Start from [[Start Here/How this works]], skim the [[Cheat Sheet]], or check [[Notes/Second Note|the second note]].

> [!note] Reading vs editing
> Notes open **read-only** in Reading View. Press **Check Out to Edit** to get an
> exclusive lock before you can change anything.

> [!warning] Sandbox only
> This demo vault is **not** written to Google Drive. Sign in to work with your
> real \`ObsidianVault-New\`.

## What's here
- [x] Obsidian-flavoured Markdown rendering
- [x] [[Wikilinks]] with \`|aliases\` and [[Notes/Second Note#Details|heading links]]
- [ ] Check-out / check-in locking
- [ ] On-demand local vault sync

Tags work too: #sandbox #pwa/obsidian

![[assets/demo-diagram.svg]]

Inline math like $E = mc^2$ and a block:

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$
`
    },
    {
      path: 'Start Here/How this works.md',
      content:
`# How this works

The app talks to **Google Drive** through the Drive REST API v3 and keeps a local
cache in IndexedDB so you can read offline.

| Feature | Sandbox | Google Drive |
|---|---|---|
| Read notes | ✅ | ✅ |
| Wikilinks & backlinks | ✅ | ✅ |
| Check-out lock | ✗ (read-only) | ✅ |
| Local vault sync | ✗ | ✅ |

See [[Welcome]] and the [[Cheat Sheet#Callouts|callouts section]].
`
    },
    {
      path: 'Notes/Second Note.md',
      content:
`---
tags: [notes, example]
---

# Second Note

A note in a subfolder, to prove shortest-path link resolution works.

## Details

Back to [[Welcome]]. This tag is nested: #pwa/obsidian.
`
    },
    {
      path: 'Cheat Sheet.md',
      content:
`# Cheat Sheet

## Callouts

> [!tip] Try it
> Callouts render with Obsidian-style colours.

> [!danger] Careful
> Force Unlock can lose another device's edits.

## Code

\`\`\`js
const lock = { obsLock: "1", obsInst: instanceId };
\`\`\`

## Math

Observation: $a^2 + b^2 = c^2$.

## Tasks

- [ ] Not done
- [x] Done
`
    },
    {
      path: 'assets/demo-diagram.svg',
      mimeType: 'image/svg+xml',
      content: IMG,
      isImage: true
    }
  ];

  ODP.demo = {
    rootName: 'ObsidianVault-New (sandbox)',
    notes() {
      const now = Date.now();
      return NOTES.map((n, idx) => Object.assign({
        id: 'demo-' + idx,
        name: n.path.split('/').pop(),
        mimeType: n.mimeType || (n.isImage ? 'image/svg+xml' : 'text/markdown'),
        modifiedTime: new Date(now - idx * 3600e3).toISOString()
      }, n));
    }
  };
})();

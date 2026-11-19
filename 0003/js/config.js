/* ============================================================
   config.js — project 0003 (Obsidian Drive PWA)
   Single place for the values that change between installs.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  // Best-effort human label for this device, used in the Drive lock
  // metadata ("obsDev") so a lock acquired here is recognisable elsewhere.
  function deviceLabel() {
    const ua = navigator.userAgent || '';
    let os = 'Unknown';
    if (/Android/i.test(ua)) os = 'Android';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    let br = 'Browser';
    if (/Edg\//.test(ua)) br = 'Edge';
    else if (/OPR\//.test(ua)) br = 'Opera';
    else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) br = 'Chrome';
    else if (/Firefox\//.test(ua)) br = 'Firefox';
    else if (/Safari\//.test(ua)) br = 'Safari';
    return os + '-' + br;
  }

  ODP.config = {
    // ── Google OAuth ──────────────────────────────────────────────
    // Paste YOUR Google Cloud *Web application* OAuth Client ID here.
    // Not a secret — safe to commit. See the project Execution Log.
    clientId: '',

    // Spec §4.1: full `drive` scope + the in-app Vault Root Jail is the
    // recommended default (full CLI / Drive-web-UI interoperability).
    // Swap to 'https://www.googleapis.com/auth/drive.file' for the strict
    // minimal-scope option (PWA-only imports; CLI files become invisible).
    scopes: 'https://www.googleapis.com/auth/drive',

    // ── Vault identity ────────────────────────────────────────────
    vaultFolderDefaultName: 'ObsidianVault-New',
    rootMarkerFile: '.pwa-vault-root.json', // written inside the new vault root

    // Normative exclusion filter (spec §4.2) — the explorer, index and the
    // local sync engine all ignore these. Paths are vault-relative, '/'-joined.
    exclusions: [
      '.obsidian/workspace.json',
      '.obsidian/workspace-mobile.json',
      '.obsidian/cache',
      '.trash',
      '.git',
      '.stfolder'
    ],

    // A file that looks like "Obsidian UI state" and must never be synced.
    isExcluded(relPath) {
      const p = String(relPath || '').replace(/^\/+/, '');
      return this.exclusions.some(e => p === e || p.startsWith(e + '/'));
    },

    deviceLabel: deviceLabel(),

    // Random per-browser instance id — the lock owner token ("obsInst").
    instanceId: null
  };
})();

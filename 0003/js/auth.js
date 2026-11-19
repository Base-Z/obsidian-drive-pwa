/* ============================================================
   auth.js — AuthModule (spec §3.2 module 1, §4.1)
   Google Identity Services token client.

   Design note: v1 uses the GIS *implicit* token flow (no redirect
   URI, no client secret) with prompt:'' silent renewal while the
   user still has a Google session. Unsaved IndexedDB drafts are
   never dropped on a 401 — the app re-invokes signIn() and resumes.
   A PKCE auth-code flow with offline refresh tokens can be slotted
   in behind the same interface later (Phase 5 hardening).
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const GIS_SRC = 'https://accounts.google.com/gsi/client';

  const Auth = {
    scriptLoaded: false,
    tokenClient: null,
    accessToken: null,
    expiresAt: 0,
    _pending: null,
    onStateChange: null,

    isConfigured() { return !!(ODP.config.clientId && ODP.config.clientId.trim()); },
    isSignedIn() { return !!this.accessToken && Date.now() < this.expiresAt - 30000; },

    _emit(state) {
      if (typeof this.onStateChange === 'function') {
        try { this.onStateChange(state, { signedIn: this.isSignedIn() }); } catch (e) {}
      }
    },

    loadScript() {
      if (this.scriptLoaded) return Promise.resolve();
      return new Promise((resolve, reject) => {
        if (window.google && window.google.accounts) { this.scriptLoaded = true; return resolve(); }
        const s = document.createElement('script');
        s.src = GIS_SRC; s.async = true; s.defer = true;
        s.onload = () => { this.scriptLoaded = true; resolve(); };
        s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
        document.head.appendChild(s);
      });
    },

    async _ensureClient() {
      await this.loadScript();
      if (this.tokenClient) return;
      this.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: ODP.config.clientId,
        scope: ODP.config.scopes,
        callback: (resp) => {
          const cb = this._pending; this._pending = null;
          if (!cb) return;
          if (resp && resp.access_token) {
            this.accessToken = resp.access_token;
            this.expiresAt = Date.now() + ((resp.expires_in ? +resp.expires_in : 3600) * 1000);
            cb.resolve(this.accessToken);
          } else {
            cb.reject(new Error(resp && resp.error ? resp.error : 'Authorization failed'));
          }
        },
        error_callback: (err) => {
          const cb = this._pending; this._pending = null;
          if (cb) cb.reject(new Error((err && err.message) || 'Authorization cancelled'));
        }
      });
    },

    // Interactive sign-in (may show the consent popup).
    async signIn() {
      if (!this.isConfigured()) throw new Error('No Google OAuth client id configured. See the Execution Log.');
      await this._ensureClient();
      this._emit('authorizing');
      return new Promise((resolve, reject) => {
        this._pending = { resolve, reject };
        this.tokenClient.requestAccessToken({ prompt: this.accessToken ? '' : 'consent' });
      });
    },

    // Silent renewal — only prompts if a silent attempt is impossible.
    async ensureToken() {
      if (this.isSignedIn()) return this.accessToken;
      await this._ensureClient();
      if (!this.isConfigured()) throw new Error('No Google OAuth client id configured.');
      this._emit('renewing');
      try {
        return await new Promise((resolve, reject) => {
          this._pending = { resolve, reject };
          this.tokenClient.requestAccessToken({ prompt: '' });
        });
      } catch (e) {
        return this.signIn();
      }
    },

    signOut() {
      if (this.accessToken && window.google && window.google.accounts) {
        try { window.google.accounts.oauth2.revoke(this.accessToken, () => {}); } catch (e) {}
      }
      this.accessToken = null; this.expiresAt = 0;
      this._emit('signed-out');
    }
  };

  ODP.auth = Auth;
})();

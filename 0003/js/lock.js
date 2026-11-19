/* ============================================================
   lock.js — Check-Out / Check-In lock manager (spec §4.3, §5.1)
   Lock state lives on Google Drive *public* `properties` (not
   appProperties) so the Python CLI and the Drive web UI can see it.
   Keys are deliberately short to stay under Drive's 124-byte
   per-property cap: obsLock / obsDev / obsInst / obsAt / obsRev.
   ============================================================ */
window.ODP = window.ODP || {};

(function () {
  'use strict';

  const K = { LOCK: 'obsLock', DEV: 'obsDev', INST: 'obsInst', AT: 'obsAt', REV: 'obsRev' };

  const LockManager = {
    // What state is this file in, from our point of view?
    // -> 'AVAILABLE' | 'CHECKED_OUT_BY_ME' | 'LOCKED_BY_OTHER_DEVICE'
    state(file) {
      const p = (file && file.properties) || {};
      if (p[K.LOCK] !== '1') return 'AVAILABLE';
      return p[K.INST] === ODP.config.instanceId ? 'CHECKED_OUT_BY_ME' : 'LOCKED_BY_OTHER_DEVICE';
    },

    owner(file) {
      const p = (file && file.properties) || {};
      return { device: p[K.DEV] || 'unknown device', at: p[K.AT] || '', instance: p[K.INST] || '' };
    },

    // The properties PATCH body that ACQUIRES the lock.
    acquireBody(file) {
      return {
        properties: {
          [K.LOCK]: '1',
          [K.DEV]: ODP.config.deviceLabel,
          [K.INST]: ODP.config.instanceId,
          [K.AT]: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          [K.REV]: (file && file.headRevisionId) || ''
        }
      };
    },

    // The properties PATCH body that RELEASES the lock (null clears a key).
    releaseBody() {
      return { properties: { [K.LOCK]: null, [K.DEV]: null, [K.INST]: null, [K.AT]: null, [K.REV]: null } };
    },

    OWNER_DEV: K.DEV, OWNER_AT: K.AT, OWNER_INST: K.INST, OWNER_REV: K.REV
  };

  ODP.LockManager = LockManager;
})();

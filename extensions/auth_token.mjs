/**
 * auth_token — load a shared secret from env or file, expose constant-time
 * compare via __ccpAuth. Used by headless_bridge (and any future outbound
 * signing).
 *
 * Resolution order:
 *   1. CC_BRIDGE_TOKEN env var (literal secret)
 *   2. CC_BRIDGE_TOKEN_FILE (path; first line trimmed)
 *   3. ~/.config/ccpatch/token  (fallback)
 *
 * Rotation: on SIGHUP, re-reads the file source.
 */
import { spliceBoot } from '../runner/patch-helpers.mjs';

export default {
  category: 'infrastructure',
  description: 'Shared-secret loader + constant-time compare exposed as __ccpAuth.',
  capabilities: ['env', 'fs'],
  // Injected hook references the sentinel twice (idempotency guard + assignment),
  // so a single clean apply yields exactly 2 occurrences. count>2 ⇒ double-applied.
  verify: { present: '__ccpAuth_v1', count: { present: 2 } },
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] auth_token — globalThis.__ccpAuth
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpAuth_v1) return;
  globalThis.__ccpAuth_v1 = true;
  // Bare \`require\` isn't in scope when the hook is injected outside the
  // CJS-IIFE wrapper (i.e. between SHEBANG and the wrapper, in an ESM
  // bundle). esm_compat publishes globalThis.__hm_require for this case.
  const __req = (typeof globalThis.__hm_require === 'function')
    ? globalThis.__hm_require
    : (typeof require === 'function' ? require : null);
  if (!__req) { console.warn('[ccpatch] auth_token: no require available — skipping'); return; }
  const fs = __req('node:fs');
  const os = __req('node:os');
  const path = __req('node:path');
  const { timingSafeEqual, createHash } = __req('node:crypto');
  let current = '';
  const load = () => {
    if (process.env.CC_BRIDGE_TOKEN) { current = process.env.CC_BRIDGE_TOKEN; return; }
    const file = process.env.CC_BRIDGE_TOKEN_FILE
      || path.join(os.homedir(), '.config', 'ccpatch', 'token');
    // Best-effort: warn (non-fatal) if the secret file is group/world-readable.
    try {
      const st = fs.statSync(file);
      if (st.mode & 0o077) {
        console.error('[ccpatch] auth_token: token file ' + file + ' is group/world-readable (mode ' + (st.mode & 0o777).toString(8) + '); chmod 600 it');
      }
    } catch (_) {}
    try { current = fs.readFileSync(file, 'utf8').split(/\\r?\\n/)[0].trim(); }
    catch (_) { current = ''; }
  };
  load();
  try { process.on('SIGHUP', load); } catch (_) {}
  globalThis.__ccpAuth = {
    has() { return current.length > 0; },
    verify(presented) {
      const got = (presented || '').replace(/^Bearer\\s+/i, '');
      if (!current) return false;
      // Hash both sides to a fixed 32-byte digest before comparing, so the
      // compare is length-independent and never short-circuits on a length
      // mismatch (which would leak the secret's length via timing).
      try {
        const a = createHash('sha256').update(current, 'utf8').digest();
        const b = createHash('sha256').update(got, 'utf8').digest();
        return timingSafeEqual(a, b);
      } catch (_) { return false; }
    },
    reload: load,
  };
  if (typeof globalThis.__ccpProvide === 'function') {
    try {
      globalThis.__ccpProvide('auth', {
        version: 1,
        producer: 'auth_token',
        shape: ['has', 'verify', 'reload'],
        value: globalThis.__ccpAuth,
      });
    } catch (_) {}
  }
})();
`;
    return spliceBoot(code, hook);
  },
};

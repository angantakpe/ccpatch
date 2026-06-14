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
  // Shared boot-anchor prepend with the other orchestration-bus patches — see the
  // note in event_bus.mjs. Mutual acknowledgement of intended co-location.
  allowOverlapWith: ['event_bus', 'agent_lifecycle', 'agent_tree'],
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
    // The token is ROOT-EQUIVALENT (see __warnWeakToken below): anyone who can
    // read this file gains full in-process access. A group/world-readable
    // secret file is therefore a real key-leak, not a style nit. Treat readable
    // perms as FAIL-CLOSED: refuse to load the token (current stays '') so the
    // bridge rejects every connection instead of serving an exposed secret.
    // On POSIX the default-config path is also pre-created with 0600 so the
    // common 'echo > ~/.config/ccpatch/token' workflow can't silently land at
    // an inherited-umask mode. Override CC_BRIDGE_TOKEN_FILE owns its own perms;
    // we still refuse to read it if it is group/world-readable.
    const isWindows = (process.platform === 'win32');
    if (!process.env.CC_BRIDGE_TOKEN_FILE && !isWindows) {
      // Pre-create the default path at 0600 so a fresh write inherits tight perms.
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
      } catch (_) {}
    }
    try {
      const st = fs.statSync(file);
      // POSIX perm bits only; skip the check on Windows where st.mode group/
      // world bits are not meaningful.
      if (!isWindows && (st.mode & 0o077)) {
        console.error('[ccpatch] auth_token: REFUSING to load token file ' + file + ' — it is group/world-readable (mode ' + (st.mode & 0o777).toString(8) + '), which leaks a ROOT-EQUIVALENT secret. Run: chmod 600 ' + file + ' (or set CC_BRIDGE_TOKEN). The bridge will reject all connections until this is fixed.');
        current = '';
        return;
      }
    } catch (_) {}
    try { current = fs.readFileSync(file, 'utf8').split(/\\r?\\n/)[0].trim(); }
    catch (_) { current = ''; }
  };
  // The bridge token is root-equivalent BY DESIGN: anyone who presents it can
  // submit prompts / dispatch tools in this process. A short token is brute-
  // forceable, so warn (once per resolved value, to avoid SIGHUP-reload spam)
  // when the resolved secret is non-empty but shorter than 16 chars.
  let __warnedWeak = null;
  const __warnWeakToken = () => {
    if (current && current.length < 16 && __warnedWeak !== current) {
      __warnedWeak = current;
      console.warn('[ccpatch] auth_token: bridge token is only ' + current.length + ' chars — it is ROOT-EQUIVALENT; use >= 16 random chars (e.g. openssl rand -hex 16)');
    }
  };
  load();
  __warnWeakToken();
  try { process.on('SIGHUP', () => { load(); __warnWeakToken(); }); } catch (_) {}
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

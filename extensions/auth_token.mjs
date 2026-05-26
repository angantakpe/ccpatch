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
export default {
  category: 'infrastructure',
  description: 'Shared-secret loader + constant-time compare exposed as __ccpAuth.',
  capabilities: ['env', 'fs'],
  verify: { present: '__ccpAuth_v1', count: { present: 1 } },
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
  const { timingSafeEqual } = __req('node:crypto');
  let current = '';
  const load = () => {
    if (process.env.CC_BRIDGE_TOKEN) { current = process.env.CC_BRIDGE_TOKEN; return; }
    const file = process.env.CC_BRIDGE_TOKEN_FILE
      || path.join(os.homedir(), '.config', 'ccpatch', 'token');
    try { current = fs.readFileSync(file, 'utf8').split(/\\r?\\n/)[0].trim(); }
    catch (_) { current = ''; }
  };
  load();
  try { process.on('SIGHUP', load); } catch (_) {}
  globalThis.__ccpAuth = {
    has() { return current.length > 0; },
    verify(presented) {
      const got = (presented || '').replace(/^Bearer\\s+/i, '');
      if (!current || current.length !== got.length) return false;
      try { return timingSafeEqual(Buffer.from(current), Buffer.from(got)); }
      catch (_) { return false; }
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
    const SHEBANG = '#!/usr/bin/env node';
    const IIFE = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(SHEBANG)) return code.replace(SHEBANG, () => SHEBANG + '\n' + hook);
    if (code.includes(IIFE)) return code.replace(IIFE, () => hook + IIFE);
    console.warn('  [!] auth_token: anchor not found — skipping');
    return code;
  },
};

export default {
  category: 'infrastructure',

  description: 'Load project .env into process.env before any other patch runs (variables already set in shell take precedence)',
  capabilities: ["env","fs"],
  // No dependsOn — runs LAST in patch order (moved to end of PATCH list in vars.mk)
  // so it is applied after all other patches. Its hook injects BEFORE the first
  // existing [PATCH] comment, guaranteeing it executes FIRST at runtime.
  verify: {
    present: '__ccpDotenvLoaded',
    label: 'Dotenv Loader',
    // count: the include-guard early-return references the sentinel once + the
    // assignment sets it once == 2 occurrences after a correct apply.
    count: { present: 2 },
  },
  apply: (code) => {
    if (code.includes('__ccpDotenvLoaded')) return code;

    const hook = `
// ── [PATCH] Dotenv Loader (must run before any env-gated patch) ──────────
if (!globalThis.__ccpDotenvLoaded) {
  globalThis.__ccpDotenvLoaded = true;
  (function() {
    try {
      var __req = (typeof __ccp_nativeRequire === 'function') ? __ccp_nativeRequire : (typeof require === 'function' ? require : null);
      if (!__req) return;
      var __fs = __req('node:fs');
      var __path = __req('node:path');
      var __projectRoot = process.env.CC_PROJECT_ROOT || process.cwd();
      var __envPath = __path.join(__projectRoot, '.env');
      if (!__fs.existsSync(__envPath)) return;
      var __raw = __fs.readFileSync(__envPath, 'utf8');
      var __lines = __raw.split('\\n');
      for (var __i = 0; __i < __lines.length; __i++) {
        var __line = __lines[__i].trim();
        if (!__line || __line.charAt(0) === '#') continue;
        var __eq = __line.indexOf('=');
        if (__eq < 1) continue;
        var __key = __line.slice(0, __eq).trim();
        var __val = __line.slice(__eq + 1).trim();
        // Strip wrapping quotes (single or double)
        if (__val.length >= 2) {
          var __first = __val.charAt(0);
          var __last = __val.charAt(__val.length - 1);
          if ((__first === '"' && __last === '"') || (__first === "'" && __last === "'")) {
            __val = __val.slice(1, -1);
          }
        }
        // Don't override values already set in the shell
        if (process.env[__key] === undefined || process.env[__key] === '') {
          process.env[__key] = __val;
        }
      }
      if (process.env.CC_DEBUG) {
        process.stderr.write('[dotenv_loader] loaded ' + __envPath + '\\n');
      }
    } catch (__envErr) {
      if (process.env.CC_DEBUG) process.stderr.write('[dotenv_loader] error: ' + (__envErr && __envErr.message) + '\\n');
    }
  })();
}
`;

    // Inject before the first existing patch hook so dotenv executes first at runtime.
    // All other patches have already been applied (dotenv_loader runs last in patch order),
    // so there will always be at least one [PATCH] comment to anchor against.
    const firstPatchComment = code.match(/\/\/ ── \[PATCH\][^\n]*\n/);
    if (firstPatchComment) {
      const idx = code.indexOf(firstPatchComment[0]);
      return code.slice(0, idx) + hook + '\n' + code.slice(idx);
    }

    // Fallback: no other patches injected yet — use the CJS-IIFE anchor directly.
    const anchor = '(function(exports, require, module, __filename, __dirname) {';
    if (!code.includes(anchor)) {
      console.warn('  [!] dotenv_loader: anchor not found — skipping');
      return code;
    }
    return code.replace(anchor, function() { return anchor + hook; });
  },
};

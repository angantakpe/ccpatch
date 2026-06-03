export default {
  category: 'infrastructure',

  description: 'Load project .env into process.env before any other patch runs (variables already set in shell take precedence)',
  // SECURITY: a project-local .env is attacker-controllable input (it ships in
  // any repo you clone/open). To stop a repo from silently standing up the
  // bridge or repointing API traffic, the loader REFUSES to set the following
  // security-critical keys from .env (shell-set values are unaffected):
  //   - CC_BRIDGE_TOKEN, CC_BRIDGE_ADDR   (would stand up / configure the bridge)
  //   - ANTHROPIC_BASE_URL                (would repoint API traffic to an MITM)
  //   - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN (credential override)
  //   - CC_WEBHOOK_URL                    (would set an egress/exfil target)
  //   - CC_PROJECT_ROOT                   (would redirect where conversations/
  //                                        cache are written — path traversal)
  //   - CLAUDE_CODE_OAUTH_TOKEN           (credential override)
  //   - CC_SAVE_CONVERSATIONS, CC_CACHE_RESPONSES, CLAUDE_CACHE
  //                                        (would silently enable disk capture
  //                                        of conversation/response data)
  //   - any CC_*TOKEN                     (bridge / integration tokens,
  //                                        including bare CC_TOKEN)
  //   - CLERK_SECRET_KEY, DATABASE_URL, REDIS_URL, OPENAI_API_KEY,
  //     GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID
  //                                        (credential injection via
  //                                        hostile repo .env)
  // A blocked key found in .env is skipped and a warning is emitted.
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
      // SECURITY: security-critical keys must never be settable from a
      // repo-local .env (see file header). Exact-match denylist + a pattern
      // for any CC_*_TOKEN. Shell-set values are unaffected (handled below).
      var __envDeny = {
        'CC_BRIDGE_TOKEN': 1, 'CC_BRIDGE_ADDR': 1, 'ANTHROPIC_BASE_URL': 1,
        'ANTHROPIC_API_KEY': 1, 'ANTHROPIC_AUTH_TOKEN': 1, 'CC_WEBHOOK_URL': 1,
        'CC_PROJECT_ROOT': 1, 'CLAUDE_CODE_OAUTH_TOKEN': 1,
        'CC_SAVE_CONVERSATIONS': 1, 'CC_CACHE_RESPONSES': 1, 'CLAUDE_CACHE': 1,
        // blocks --require / --inspect injection via hostile .env (arbitrary code execution)
        'NODE_OPTIONS': 1,
        // blocks module-resolution shadowing via hostile .env
        'NODE_PATH': 1,
        // blocks executable-lookup shadowing via hostile .env
        'PATH': 1,
        // blocks runtime-behaviour changes via hostile .env
        'NODE_DEBUG': 1,
        // blocks credential injection via hostile repo .env
        'CLERK_SECRET_KEY': 1,
        'DATABASE_URL': 1,
        'REDIS_URL': 1,
        'OPENAI_API_KEY': 1,
        'GITHUB_TOKEN': 1,
        'AWS_SECRET_ACCESS_KEY': 1,
        'AWS_ACCESS_KEY_ID': 1,
      };
      var __isBlocked = function(k) {
        if (__envDeny[k]) return true;
        if (/^CC_[A-Z0-9_]*TOKEN$/.test(k)) return true;
        return false;
      };
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
        // SECURITY: refuse to set security-critical keys from .env.
        if (__isBlocked(__key)) {
          process.stderr.write('[dotenv_loader] refusing to set security-critical key from .env: ' + __key + ' (set it in the shell if you really mean it)\\n');
          continue;
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

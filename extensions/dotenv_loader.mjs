export default {
  category: 'infrastructure',

  description: 'Load project .env into process.env before any other patch runs (variables already set in shell take precedence)',
  // SECURITY: a project-local .env is attacker-controllable input (it ships in
  // any repo you clone/open). A denylist loses by construction — a hostile .env
  // can inject ANY key that is not on the list (OPENAI_API_KEY, arbitrary
  // MCP-server creds, CLAUDE_DEBUG=1, ...) straight into the user's Claude Code
  // process. So this loader is FAIL-CLOSED: it uses an ALLOWLIST and refuses to
  // set anything not explicitly permitted (shell-set values are unaffected).
  //
  // The allowlist is intentionally restrictive. It contains only the benign
  // runtime configuration knobs that ccpatch's own extensions legitimately read
  // from the environment (verified by grepping process.env reads across
  // extensions/), namely:
  //   - the CC_* family the extensions consume (thinking/pricing/effort/etc.)
  //     EXCEPT the dangerous CC_* keys, which stay blocked even though they
  //     match the CC_* prefix (see __envDenyCC below):
  //       CC_BRIDGE_*            (would stand up / configure / weaken the bridge)
  //       CC_WEBHOOK_URL         (would set an egress/exfil target)
  //       CC_PROJECT_ROOT        (would redirect where conversations/cache are
  //                               written — path traversal)
  //       CC_SAVE_CONVERSATIONS, CC_CACHE_RESPONSES
  //                              (would silently enable disk capture of data)
  //       any CC_*TOKEN          (bridge / integration tokens, incl. bare CC_TOKEN)
  //   - a small set of known-safe app/display vars (model display, retry/rate
  //     tuning, NO_COLOR/FORCE_COLOR).
  //
  // Deliberately NOT on the allowlist (fail-closed by default, called out for
  // clarity): ANTHROPIC_* (base-url repoint / credential override / model
  // selection); ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
  // (credentials); CLAUDE_CACHE (disk capture); CLAUDE_DEBUG (writes a debug log
  // to disk); NODE_OPTIONS / NODE_PATH / PATH / NODE_DEBUG (code-exec / lookup
  // shadowing); and every third-party credential (OPENAI_API_KEY, GITHUB_TOKEN,
  // DATABASE_URL, REDIS_URL, CLERK_SECRET_KEY, AWS_*, ...). Anything not named
  // here is refused regardless of how it is spelled.
  //
  // Skipped keys are reported once via a single deduplicated stderr warning.
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
      // SECURITY: FAIL-CLOSED allowlist (see file header). Only keys that are
      // (a) explicitly named below, OR (b) match the CC_* prefix the extensions
      // legitimately use AND are not in the dangerous-CC_* deny subset, are
      // loaded from .env. Everything else is refused. Shell-set values are
      // unaffected (handled below).
      var __envAllow = {
        // benign CC_* runtime knobs consumed by ccpatch extensions
        'CC_DEBUG': 1, 'CC_THINKING': 1, 'CC_THINKING_BUDGET': 1,
        'CC_EFFORT_LEVEL': 1, 'CC_PRICING_INPUT': 1, 'CC_PRICING_OUTPUT': 1,
        'CC_WORKSPACE': 1, 'CC_RATE_LIMIT_PATCH_ENABLED': 1,
        // known-safe app/display vars
        'CLAUDE_MODEL': 1, 'CLAUDE_MODEL_DISPLAY': 1, 'MAX_THINKING_TOKENS': 1,
        'CLAUDE_RATE_LIMIT': 1, 'CLAUDE_MAX_RETRIES': 1,
        'CLAUDE_MAX_RETRY_AFTER_MS': 1, 'NO_COLOR': 1, 'FORCE_COLOR': 1,
      };
      // Dangerous CC_* keys: blocked even though they match the CC_* prefix.
      var __envDenyCC = {
        'CC_BRIDGE_TOKEN': 1, 'CC_BRIDGE_TOKEN_FILE': 1, 'CC_BRIDGE_ADDR': 1,
        'CC_BRIDGE_ALLOW_PUBLIC': 1, 'CC_BRIDGE_MAX_LINE': 1,
        'CC_BRIDGE_TOOL_ALLOWLIST': 1, 'CC_WEBHOOK_URL': 1, 'CC_PROJECT_ROOT': 1,
        'CC_SAVE_CONVERSATIONS': 1, 'CC_CACHE_RESPONSES': 1,
      };
      var __isAllowed = function(k) {
        if (__envAllow[k]) return true;
        // CC_* prefix family, minus the dangerous CC_* keys and any CC_*TOKEN.
        if (/^CC_[A-Z0-9_]+$/.test(k)) {
          if (__envDenyCC[k]) return false;
          if (/TOKEN$/.test(k)) return false;
          return true;
        }
        return false;
      };
      var __skipped = [];
      var __skippedSeen = {};
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
        // SECURITY: fail-closed — only load keys on the allowlist.
        if (!__isAllowed(__key)) {
          if (!__skippedSeen[__key]) { __skippedSeen[__key] = 1; __skipped.push(__key); }
          continue;
        }
        // Don't override values already set in the shell
        if (process.env[__key] === undefined || process.env[__key] === '') {
          process.env[__key] = __val;
        }
      }
      // SECURITY INVARIANT: never emit a secret VALUE. Every write below logs
      // only KEY NAMES (__skipped), a file path (__envPath), or an fs/parse
      // error message — __val is never interpolated into any output, on any
      // path. The loaded-value array (__val) stays inside process.env only.
      if (__skipped.length) {
        process.stderr.write('[dotenv_loader] refused ' + __skipped.length + ' key(s) from .env not on the allowlist (set them in the shell if you really mean it): ' + __skipped.join(', ') + '\\n');
      }
      if (process.env.CC_DEBUG) {
        process.stderr.write('[dotenv_loader] loaded ' + __envPath + '\\n');
      }
    } catch (__envErr) {
      // __envErr.message comes from fs/path ops here and never carries a .env
      // value (values are not interpolated into any throw above).
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

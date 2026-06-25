
export default {
    category: 'optional',
    enabled: false,

    description: 'Track session time and warn about long sessions',
    capabilities: [],
    verify: { present: 'SESSION_START', count: { present: 2 } },
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Session Timer
// ══════════════════════════════════════════════════════════════════════════

const SESSION_START = Date.now();
const WARN_AFTER_MINUTES = 30;
const MAX_SESSION_MINUTES = 60;

let warned = false;
const __ccpSessionTimer = setInterval(() => {
  const minutes = (Date.now() - SESSION_START) / 60000;

  if (!warned && minutes >= WARN_AFTER_MINUTES) {
    process.stderr.write('\\n[TIMER] ⚠️  Session has been running for ' + Math.floor(minutes) + ' minutes\\n');
    warned = true;
  }

  if (minutes >= MAX_SESSION_MINUTES) {
    process.stderr.write('\\n[TIMER] 🛑 Maximum session time reached. Consider taking a break!\\n');
  }
}, 60000);
// Don't let this background timer hold the event loop open on its own —
// otherwise print-and-exit invocations (--version/--help) never exit.
// Fail open: guard for non-Node timer shims that lack .unref().
try { if (__ccpSessionTimer && typeof __ccpSessionTimer.unref === 'function') __ccpSessionTimer.unref(); } catch (_e) {}

`;
          const _CJS_IIFE = '(function(exports, require, module, __filename, __dirname) {';
    // Idempotency guard (rule 2): the hook embeds this unique banner; if it's
    // already present the bundle is patched — return unchanged.
    if (code.includes('[PATCH] Session Timer')) return code;
    if (code.startsWith('#!/usr/bin/env node')) {
      return code.replace('#!/usr/bin/env node', '#!/usr/bin/env node' + hook);
    } else if (code.includes(_CJS_IIFE)) {
      return code.replace(_CJS_IIFE, () => _CJS_IIFE + hook);
    } else {
      console.warn('  [!] anchor not found (no shebang, no CJS-IIFE) — skipping');
      return code;
    }
    }
  };


export default {
    category: 'optional',
    enabled: false,

    // SECURITY: this patch egresses UNREDACTED conversation/event data
    // (args, cwd, pid, event payloads) to CLAUDE_WEBHOOK_URL. Outbound is
    // restricted to https: (or http://localhost for dev) — see scheme check
    // in the injected hook below.
    description: 'Send webhook notifications on key events. WARNING: egresses unredacted conversation/event data to CLAUDE_WEBHOOK_URL.',
    capabilities: ["network","env","telemetry"],
    // The injected hook embeds the marker string '__ccpWebhook_v1' exactly once
    // and never references __sendWebhook__ before defining it, so present+count
    // give a non-weak verify. count>1 ⇒ double-applied.
    verify: { present: '__ccpWebhook_v1', count: { present: 1 } },
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Webhook Notifications  (marker: __ccpWebhook_v1)
// ══════════════════════════════════════════════════════════════════════════
// WARNING: this sends UNREDACTED conversation/event data (CLI args, cwd, pid,
// event payloads) outbound to CLAUDE_WEBHOOK_URL. Treat that endpoint as a
// data sink with full visibility into your session.

const WEBHOOK_URL = process.env.CLAUDE_WEBHOOK_URL;

// Scheme allowlist: only https:, or http://localhost (+127.0.0.1/[::1]) for
// local dev. Anything else (plain http:, file:, etc.) is rejected so secrets
// and conversation data can't egress over an unauthenticated/cleartext channel.
const __ccpWebhookAllowed = (raw) => {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1')) return true;
    return false;
  } catch (_) { return false; }
};

globalThis.__sendWebhook__ = async (event, data) => {
  if (!WEBHOOK_URL) return;
  if (!__ccpWebhookAllowed(WEBHOOK_URL)) {
    console.error('[ccpatch] webhook: refusing to POST to ' + WEBHOOK_URL + ' — only https: (or http://localhost for dev) is allowed');
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        cwd: process.cwd(),
        ...data
      })
    });
  } catch (e) {
    // Silent fail
  }
};

// Notify on startup
globalThis.__sendWebhook__('session_start', { 
  args: process.argv.slice(2) 
});

process.on('exit', (code) => {
  globalThis.__sendWebhook__('session_end', { exitCode: code });
});

`;
      const _SHEBANG_ = '#!/usr/bin/env node';
    const _CJS_IIFE_ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(_SHEBANG_)) return code.replace(_SHEBANG_, _SHEBANG_ + '\n' + hook);
    if (code.includes(_CJS_IIFE_)) return code.replace(_CJS_IIFE_, () => hook + _CJS_IIFE_);
    console.warn('  [!] webhook: anchor not found — skipping');
    return code;
    }
  };

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
    category: 'optional',
    enabled: false,

    description: 'Send webhook notifications on key events',
    capabilities: ["network","env","telemetry"],
    verify: { present: '__sendWebhook__', weak: true },
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Webhook Notifications
// ══════════════════════════════════════════════════════════════════════════

const WEBHOOK_URL = process.env.CLAUDE_WEBHOOK_URL;

globalThis.__sendWebhook__ = async (event, data) => {
  if (!WEBHOOK_URL) return;
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

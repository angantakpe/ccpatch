import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
    category: 'optional',
    enabled: false,

    description: 'Add debug logging for API calls and tool usage',
    capabilities: ["network","fs","env","telemetry"],
    verify: { present: '__debugLog__', weak: true },
    apply: (code) => {
      const debugHook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Debug Logging (set CLAUDE_DEBUG=1 to enable, logs to ~/.claude-debug.log)
// ══════════════════════════════════════════════════════════════════════════

const __DEBUG_ENABLED__ = process.env.CLAUDE_DEBUG === '1';
let __debugLog__ = () => {};
let __debugReady__ = Promise.resolve();

if (__DEBUG_ENABLED__) {
  __debugReady__ = (async () => {
    const { appendFileSync: __appendLog } = await import('fs');
    const { join: __joinPath } = await import('path');
    const __debugFile = __joinPath(process.env.HOME || '.', '.claude-debug.log');
    __debugLog__ = (...args) => {
      const line = '[' + new Date().toISOString() + '] ' + args.join(' ') + '\\n';
      try { __appendLog(__debugFile, line); } catch {}
    };
    __debugLog__('=== Session started PID:', process.pid, '===');
  })();
}

// Register debug subscriber via shared fetch interceptor
globalThis.__ccpOnFetch?.('debug', ({ url, options, response, isApi, events }) => {
  if (!__DEBUG_ENABLED__) return;
  if (isApi && events) {
    __debugLog__('fetch API ←', response?.status, 'events:', events.length);
  }
});

// Also log outgoing requests directly (pre-response) — wrap fetch for timing
(function() {
  const __debugFetchOuter__ = globalThis.fetch;
  globalThis.fetch = async function patchedDebugFetch(url, options) {
    if (__DEBUG_ENABLED__) await __debugReady__;
    const startTime = Date.now();
    __debugLog__('fetch →', typeof url === 'string' ? url : url?.url);
    try {
      const response = await __debugFetchOuter__.apply(this, arguments);
      __debugLog__('fetch ←', response.status, (Date.now() - startTime) + 'ms');
      return response;
    } catch (err) {
      __debugLog__('fetch ERROR:', err.message);
      throw err;
    }
  };
})();

`;
      const __shebang__ = '#!/usr/bin/env node';
      const __cjsIife__ = '(function(exports, require, module, __filename, __dirname)';
      if (code.includes(__shebang__)) {
        return code.replace(__shebang__, __shebang__ + debugHook);
      } else if (code.includes(__cjsIife__)) {
        return code.replace(__cjsIife__, debugHook + __cjsIife__);
      }
      console.warn('  [!] patch: no shebang or CJS-IIFE anchor found — skipping');
      return code;
    }
  };

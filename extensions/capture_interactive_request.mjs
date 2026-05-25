/**
 * capture_interactive_request — One-shot capture of the next successful
 * /v1/messages request made by the interactive CLI. Used to reverse-engineer
 * the auth/header pattern that consumer Claude.ai OAuth tokens need.
 *
 * Writes to storage/logs/interactive-request-capture.jsonl exactly once
 * (first 2xx response to api.anthropic.com seen by the patched fetch).
 *
 * Disable after capture by removing this patch from vars.mk or deleting the
 * output file (the patch checks if the file already exists).
 */

export default {
  category: 'expose',

  description: 'Capture first successful interactive /v1/messages request shape for shadow-agent reuse.',
  capabilities: ["network"],
  verify: { present: '__ccpInteractiveRequestCaptured_v1' },
  apply: (code) => {
    if (code.includes('__ccpInteractiveRequestCaptured_v1')) return code;
    const SHEBANG = '#!/usr/bin/env node';
    const CJS_IIFE = '(function(exports, require, module, __filename, __dirname) {';
    const useShebang = code.includes(SHEBANG);
    const useCjsIife = !useShebang && code.includes(CJS_IIFE);
    if (!useShebang && !useCjsIife) {
      console.warn('  [!] capture_interactive_request: no shebang or CJS-IIFE anchor — skipping');
      return code;
    }

    const inject = `var __ccpInteractiveRequestCaptured_v1=!0;
(function(){
  try {
    var fs = require('node:fs');
    var path = require('node:path');
    var captureFile = 'storage/logs/interactive-request-capture.jsonl';
    if (fs.existsSync(captureFile)) return; // already captured
    var origFetch = globalThis.fetch;
    if (typeof origFetch !== 'function') return;
    var done = false;
    globalThis.fetch = async function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (done || !url.includes('api.anthropic.com') || !url.includes('/messages')) {
        return origFetch.apply(this, arguments);
      }
      var reqHeaders = {};
      try {
        var h = (init && init.headers) || (input && input.headers);
        if (h && typeof h.forEach === 'function') h.forEach(function(v, k){ reqHeaders[k] = v; });
        else if (h && typeof h === 'object') Object.assign(reqHeaders, h);
      } catch (_) {}
      var reqBody = null;
      try { reqBody = (init && init.body) ? (typeof init.body === 'string' ? init.body : String(init.body)) : null; } catch (_) {}
      var res = await origFetch.apply(this, arguments);
      try {
        if (!done && res && res.status >= 200 && res.status < 300) {
          done = true;
          fs.mkdirSync('storage/logs', { recursive: true });
          fs.writeFileSync(captureFile, JSON.stringify({
            ts: new Date().toISOString(),
            url: url,
            method: (init && init.method) || 'POST',
            requestHeaders: reqHeaders,
            requestBodyPreview: reqBody ? reqBody.slice(0, 4000) : null,
            responseStatus: res.status,
            responseHeaders: (function(){ var o = {}; res.headers.forEach(function(v, k){ o[k] = v; }); return o; })(),
          }) + '\\n');
          process.stderr.write('[capture_interactive_request] captured first successful messages request → ' + captureFile + '\\n');
        }
      } catch (_) {}
      return res;
    };
    process.stderr.write('[capture_interactive_request] fetch hook installed\\n');
  } catch (_) {}
})();
`;
    if (useShebang) return code.replace(SHEBANG, SHEBANG + '\n' + inject);
    return code.replace(CJS_IIFE, () => CJS_IIFE + inject);
  },
};

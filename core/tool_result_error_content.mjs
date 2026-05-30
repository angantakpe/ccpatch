/**
 * tool_result_error_content — Guard against Anthropic API 400:
 *   "messages.N.content.M.tool_result: content cannot be empty if is_error is true"
 *
 * Some MCP tools and the bundle's own tool dispatch produce tool_result blocks
 * with `is_error: true` and `content: ""` (or `[]`). The Anthropic API rejects
 * those — schema requires non-empty content when is_error=true.
 *
 * This patch hooks the shared fetch interceptor and rewrites any offending
 * tool_result block with a single text placeholder so the request goes
 * through. Truth is preserved (is_error stays true) — we only fill the body.
 *
 * NOTE on injection order: patches inject content RIGHT AFTER the shebang.
 * Later-listed patches end up running EARLIER at boot because each replace
 * pushes prior blocks down. So this patch runs BEFORE fetch_interceptor has
 * defined __ccpOnFetchBefore. We poll for the hook with setImmediate.
 */

export default {
  category: 'fix',

  description: 'Inject placeholder content for empty tool_result blocks with is_error:true (Anthropic API requires non-empty content).',
  capabilities: ["network"],
  verify: { present: '__ccpTREC_init', count: { present: 1 } },
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] tool_result_error_content
// Empty content + is_error:true → API 400. Inject placeholder.
// ══════════════════════════════════════════════════════════════════════════
(function __ccpTREC_init() {
  function hook(ctx) {
    if (!ctx.isApi || !ctx.options || !ctx.options.body) return;
    try {
      var body = typeof ctx.options.body === 'string' ? JSON.parse(ctx.options.body) : ctx.options.body;
      if (!body || !Array.isArray(body.messages)) return;
      var modified = false;
      var errBlocksFound = 0;
      var errBlocksEmpty = 0;
      for (var mi = 0; mi < body.messages.length; mi++) {
        var msg = body.messages[mi];
        if (!msg || !Array.isArray(msg.content)) continue;
        for (var ci = 0; ci < msg.content.length; ci++) {
          var block = msg.content[ci];
          if (!block || block.type !== 'tool_result') continue;
          if (block.is_error !== true) continue;
          errBlocksFound++;
          var c = block.content;
          var empty = false;
          if (c == null) empty = true;
          else if (typeof c === 'string') empty = c.length === 0;
          else if (Array.isArray(c)) {
            if (c.length === 0) empty = true;
            else {
              empty = c.every(function(b) {
                if (!b || typeof b !== 'object') return true;
                if (b.type === 'text') return !b.text || typeof b.text !== 'string' || b.text.length === 0;
                return false;
              });
            }
          } else empty = true;
          if (empty) {
            errBlocksEmpty++;
            block.content = [{ type: 'text', text: '[tool errored with no content — placeholder inserted by ccpatch]' }];
            modified = true;
          }
        }
      }
      if (errBlocksFound > 0) {
        try { process.stderr.write('[tool_result_error_content] errBlocks found=' + errBlocksFound + ' empty=' + errBlocksEmpty + ' modified=' + modified + '\\n'); } catch (_) {}
      }
      if (modified) {
        ctx.options = Object.assign({}, ctx.options, { body: JSON.stringify(body) });
      }
    } catch (e) {
      try { process.stderr.write('[tool_result_error_content] body parse err: ' + (e && e.message || e) + '\\n'); } catch (_) {}
    }
  }

  function trySubscribe() {
    if (typeof globalThis.__ccpOnFetchBefore !== 'function') return false;
    try {
      globalThis.__ccpOnFetchBefore('tool_result_error_content', hook, 30);
      (globalThis.__ccpBootBuf || (globalThis.__ccpBootBuf = [])).push(['trec', 'subscribed to fetch-before']);
      if (globalThis.__ccpBootKick) globalThis.__ccpBootKick();
    } catch (_e) {
      try { process.stderr.write('[tool_result_error_content] subscribe error: ' + (_e && _e.message || _e) + '\\n'); } catch (_) {}
    }
    return true;
  }

  // Try immediately (in case fetch_interceptor already initialised), then
  // poll via setImmediate until it shows up. Cap at ~60 attempts (≈ a few ms).
  if (trySubscribe()) return;
  var attempts = 0;
  function poll() {
    if (trySubscribe()) return;
    if (++attempts >= 60) {
      try { process.stderr.write('[tool_result_error_content] gave up waiting for __ccpOnFetchBefore after 60 attempts\\n'); } catch (_) {}
      return;
    }
    setImmediate(poll);
  }
  setImmediate(poll);
})();
`;
    const _SHEBANG_ = '#!/usr/bin/env node';
    const _CJS_IIFE_ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(_SHEBANG_)) return code.replace(_SHEBANG_, _SHEBANG_ + '\n' + hook);
    // Use includes() + replace() — fetch_interceptor may have prepended code before
    // the CJS-IIFE, so startsWith() would miss it. Use function replacement to
    // prevent any $-patterns in the hook from being expanded by replace().
    if (code.includes(_CJS_IIFE_)) return code.replace(_CJS_IIFE_, () => hook + _CJS_IIFE_);
    console.warn('  [!] tool_result_error_content: anchor not found — skipping');
    return code;
  },
};

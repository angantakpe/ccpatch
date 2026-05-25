export default {
  category: 'observe',

  description: 'Truncate oversized tool_result content blocks before they are sent to the API (saves tokens)',
  capabilities: ["network","tools"],
  verify: { present: "'tool_result_trim'" },
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Tool Result Trim
// Truncates tool_result content blocks > 8000 chars in outgoing API requests.
// Exempt: blocks with is_error: true (errors should be seen in full).
// ══════════════════════════════════════════════════════════════════════════

try {
  var __TOOL_RESULT_MAX__ = 8000;
  if (typeof globalThis.__ccpOnFetchBefore === 'function') {
    globalThis.__ccpOnFetchBefore('tool_result_trim', function(ctx) {
      if (!ctx.isApi || !ctx.options || !ctx.options.body) return;
      try {
        var body = typeof ctx.options.body === 'string' ? JSON.parse(ctx.options.body) : ctx.options.body;
        if (!body || !Array.isArray(body.messages)) return;
        var modified = false;
        for (var mi = 0; mi < body.messages.length; mi++) {
          var msg = body.messages[mi];
          if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
          for (var ci = 0; ci < msg.content.length; ci++) {
            var block = msg.content[ci];
            if (block.type !== 'tool_result') continue;
            if (block.is_error) continue; // exempt error blocks
            if (typeof block.content === 'string') {
              if (block.content.length > __TOOL_RESULT_MAX__) {
                block.content = block.content.slice(0, __TOOL_RESULT_MAX__) +
                  '\\n[... ' + (block.content.length - __TOOL_RESULT_MAX__) + ' chars truncated. Re-read the file or re-run the command if needed.]';
                modified = true;
              }
            } else if (Array.isArray(block.content)) {
              for (var bi = 0; bi < block.content.length; bi++) {
                var sub = block.content[bi];
                if (sub.type === 'text' && typeof sub.text === 'string' && sub.text.length > __TOOL_RESULT_MAX__) {
                  sub.text = sub.text.slice(0, __TOOL_RESULT_MAX__) +
                    '\\n[... ' + (sub.text.length - __TOOL_RESULT_MAX__) + ' chars truncated. Re-read the file or re-run the command if needed.]';
                  modified = true;
                }
              }
            }
          }
        }
        if (modified) {
          ctx.options = Object.assign({}, ctx.options, { body: JSON.stringify(body) });
        }
      } catch (e) {}
    }, 40);
  }
} catch (e) {
  process.stderr.write('[tool_result_trim] init error: ' + (e && e.message || e) + '\\n');
}

`;
    const _SHEBANG_ = '#!/usr/bin/env node';
    const _CJS_IIFE_ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(_SHEBANG_)) return code.replace(_SHEBANG_, _SHEBANG_ + '\n' + hook);
    if (code.includes(_CJS_IIFE_)) return code.replace(_CJS_IIFE_, () => hook + _CJS_IIFE_);
    console.warn('  [!] tool_result_trim: anchor not found — skipping');
    return code;
  },
};

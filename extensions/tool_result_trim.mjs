import { spliceBoot, registerFetchHook, FETCH_PRIORITY } from '../runner/patch-helpers.mjs';

// Handler source for the fetch-before subscriber, kept verbatim from the
// hand-written form. registerFetchHook() supplies the guard + registration
// wiring around it at priority FETCH_PRIORITY.TRIM (== 40). The body indents
// are relative to a 2-space wrapper base (indent: '  '), so the rendered output
// is byte-identical to the previous hand-rolled block.
const HANDLER = `function(ctx) {
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
    }`;

export default {
  category: 'observe',

  description: 'Truncate oversized tool_result content blocks before they are sent to the API (saves tokens)',
  capabilities: ["network","tools"],
  verify: { present: "'tool_result_trim'", count: { present: 1 } },
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    // Idempotency (rule 2): sentinel == verify.present marker. Re-apply on an
    // already-patched bundle is a byte-identical no-op.
    if (code.includes("'tool_result_trim'")) return code;
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Tool Result Trim
// Truncates tool_result content blocks > 8000 chars in outgoing API requests.
// Exempt: blocks with is_error: true (errors should be seen in full).
// ══════════════════════════════════════════════════════════════════════════

try {
  var __TOOL_RESULT_MAX__ = 8000;
${registerFetchHook('tool_result_trim', HANDLER, FETCH_PRIORITY.TRIM, { indent: '  ' })}
} catch (e) {
  process.stderr.write('[tool_result_trim] init error: ' + (e && e.message || e) + '\\n');
}

`;
    return spliceBoot(code, hook);
  },
};

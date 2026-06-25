import { spliceAfter, registerFetchHook, FETCH_PRIORITY } from '../runner/patch-helpers.mjs';

// The CJS-IIFE wrapper header. The hook is spliced *inside* the wrapper (after
// the opening brace) so it shares scope with the bundle body.
const CJS_IIFE_HEAD = '(function(exports, require, module, __filename, __dirname) {';

// Handler source for the fetch-before subscriber, kept verbatim from the
// hand-written form. registerFetchHook() supplies the guard + registration
// wiring at priority FETCH_PRIORITY.LATE (== 80, run after body rewrites). Body
// indents are relative to a 2-space wrapper base (indent: '  ') so the rendered
// output is byte-identical to the previous hand-rolled block.
const HANDLER = `function(ctx) {
      if (!ctx.isApi || !ctx.options || !ctx.options.body) return;
      try {
        var costs = globalThis.__CLAUDE_COSTS__;
        var totalInputTokens = costs && costs.lastInputTokens ? costs.lastInputTokens : 0;
        var MAX_CONTEXT = 200000;
        var WARN_THRESHOLD = Math.floor(MAX_CONTEXT * 0.85);
        if (totalInputTokens < WARN_THRESHOLD) return;
        var pct = Math.round((totalInputTokens / MAX_CONTEXT) * 100);
        var alertText = '[CONTEXT ALERT] Context is ' + pct + '% full (' + totalInputTokens + '/' + MAX_CONTEXT + ' tokens). ' +
          'Wrap up your current task and produce a concise handoff summary of: ' +
          '(1) what was accomplished, (2) what remains, (3) key file paths and state. ' +
          'This summary will survive context compaction.';
        var body = typeof ctx.options.body === 'string' ? JSON.parse(ctx.options.body) : ctx.options.body;
        if (!body) return;
        if (typeof body.system === 'string') {
          body.system = [{ type: 'text', text: body.system }, { type: 'text', text: alertText }];
        } else if (Array.isArray(body.system)) {
          body.system.push({ type: 'text', text: alertText });
        } else {
          body.system = [{ type: 'text', text: alertText }];
        }
        ctx.options = Object.assign({}, ctx.options, { body: JSON.stringify(body) });
      } catch (e) {}
    }`;

export default {
  category: 'observe',

  description: 'Inject context-full warning into system prompt when input tokens exceed 85% of 200k context limit',
  capabilities: ["network","prompt"],
  verify: { present: "'context_budget_warn'", count: { present: 1 } },
  allowOverlapWith: ['custom_commands', 'slash_dispatch'],
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    // Idempotency (rule 2): sentinel == verify.present marker. Re-apply on an
    // already-patched bundle is a byte-identical no-op.
    if (code.includes("'context_budget_warn'")) return code;
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Context Budget Warning
// When totalInputTokens exceeds 85% of 200000, injects a system block
// asking the model to produce a handoff summary.
// ══════════════════════════════════════════════════════════════════════════

try {
${registerFetchHook('context_budget_warn', HANDLER, FETCH_PRIORITY.LATE, { indent: '  ' })}
} catch (e) {
  process.stderr.write('[context_budget_warn] init error: ' + (e && e.message || e) + '\\n');
}

`;
    return spliceAfter(code, CJS_IIFE_HEAD, hook);
  },
};

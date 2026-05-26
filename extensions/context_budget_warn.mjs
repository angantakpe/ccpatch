export default {
  category: 'observe',

  description: 'Inject context-full warning into system prompt when input tokens exceed 85% of 200k context limit',
  capabilities: ["network","prompt"],
  verify: { present: "'context_budget_warn'", weak: true },
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Context Budget Warning
// When totalInputTokens exceeds 85% of 200000, injects a system block
// asking the model to produce a handoff summary.
// ══════════════════════════════════════════════════════════════════════════

try {
  if (typeof globalThis.__ccpOnFetchBefore === 'function') {
    globalThis.__ccpOnFetchBefore('context_budget_warn', function(ctx) {
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
    }, 80);
  }
} catch (e) {
  process.stderr.write('[context_budget_warn] init error: ' + (e && e.message || e) + '\\n');
}

`;
    return code.replace('(function(exports, require, module, __filename, __dirname) {', '(function(exports, require, module, __filename, __dirname) {' + hook);
  },
};

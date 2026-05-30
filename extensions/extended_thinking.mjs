export default {
  category: 'feature',

  description: 'Inject thinking/effort config into API requests via CC_THINKING and CC_EFFORT_LEVEL env vars',
  capabilities: ["network","prompt","env"],
  // count: function declaration of __ccpIsComplexPrompt + its single call site
  // == 2 occurrences after a correct apply.
  verify: { present: '__ccpIsComplexPrompt', count: { present: 2 } },
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Extended Thinking + Effort Level injection
// CC_THINKING: disabled|enabled|adaptive — injects body.thinking
//   adaptive: thinking ON for complex prompts, OFF for conversational ones
// CC_THINKING_BUDGET: token budget when thinking is ON (default 10000)
// CC_EFFORT_LEVEL: low|medium|high|xhigh|max — injects body.output_config.effort
// Only fires when ctx.isApi && body.model to avoid injecting on MCP/ACP traffic.
// ══════════════════════════════════════════════════════════════════════════

try {
  // ── Adaptive thinking: complexity scorer ────────────────────────────────
  function __ccpIsComplexPrompt(messages) {
    // Extract the last user message text
    var text = '';
    for (var i = (messages || []).length - 1; i >= 0; i--) {
      var msg = messages[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content === 'string') { text = msg.content; break; }
      if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(function(b) { return b.type === 'text'; })
          .map(function(b) { return b.text; })
          .join(' ');
        break;
      }
    }
    text = text.trim();
    if (!text) return false;

    // Long messages are always complex
    var words = text.split(/\\s+/);
    if (words.length > 15) return true;

    // Code signals → complex
    if (/\`|\bfunction\b|\bconst\b|\blet\b|\bvar\b|=>|\\{\\s*\\n|Error:|TypeError:|undefined is not|cannot read/i.test(text)) return true;

    // Task verbs → complex
    if (/\\b(debug|fix|implement|refactor|analyz|write|create|build|design|test|review|migrate|configure|install|optim|improve|update|add|remove|delete|deploy|explain|describe|help me|show me how|how (do|can|should|to)|why (does|is|are|did)|what (is|are|does|should)|plan|architect|structur|approach|generate|convert|translat|extract|pars|integrat|scaffold|bootstrap|set ?up|set up|figure out|walk me|step.by.step)\\b/i.test(text)) return true;

    // Simple greetings / acknowledgments → NOT complex
    if (/^(hi+|hey+|hello+|yo+|ok+|okay|thanks?|thank you|great|cool|good|nice|got it|understood|sure|done|yes|no|yep|nope|alright|sounds good|makes sense|perfect|awesome|lgtm|noted)[\\.!?]*$/i.test(text)) return false;

    // Short question without task verb — could go either way; default OFF
    if (words.length <= 8) return false;

    return true;
  }

  // ── Keep context_management consistent with thinking ─────────────────────
  // CC pairs body.thinking with a context_management edit
  // {type:"clear_thinking_20251015"}. That strategy is only valid while
  // thinking is enabled/adaptive, so once we remove body.thinking we MUST drop
  // the orphaned edit too — otherwise the API 400s:
  //   "clear_thinking_20251015 strategy requires thinking to be enabled or adaptive".
  function __ccpStripClearThinking(body) {
    var cm = body && body.context_management;
    if (!cm || !Array.isArray(cm.edits)) return;
    cm.edits = cm.edits.filter(function(e) {
      return !(e && typeof e.type === 'string' && e.type.indexOf('clear_thinking') === 0);
    });
    if (cm.edits.length === 0) delete body.context_management;
  }

  if (typeof globalThis.__ccpOnFetchBefore === 'function') {
    globalThis.__ccpOnFetchBefore('extended_thinking', async function(ctx) {
      if (!ctx.isApi || !ctx.options || !ctx.options.body) return;
      // Default to adaptive when unset — suppresses thinking on simple prompts
      // without requiring an explicit env var.
      var thinking = process.env.CC_THINKING || 'adaptive';
      var effort = process.env.CC_EFFORT_LEVEL;
      try {
        var body = typeof ctx.options.body === 'string' ? JSON.parse(ctx.options.body) : ctx.options.body;
        if (!body || !body.model) return; // guard: only inject on real model requests

        if (thinking === 'adaptive') {
          // Only act when CC has already enabled thinking (body.thinking present).
          // For simple prompts: suppress it. For complex: leave CC's setting intact.
          if (body.thinking) {
            if (!__ccpIsComplexPrompt(body.messages)) {
              delete body.thinking;
              __ccpStripClearThinking(body);
            }
          }
        } else if (thinking === 'enabled') {
          var budgetTokens = parseInt(process.env.CC_THINKING_BUDGET || '10000');
          body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        } else if (thinking === 'disabled') {
          delete body.thinking;
          __ccpStripClearThinking(body);
        }

        if (effort) {
          body.output_config = body.output_config || {};
          body.output_config.effort = { level: effort };
        }

        ctx.options = Object.assign({}, ctx.options, { body: JSON.stringify(body) });
      } catch (e) {
        process.stderr.write('[extended_thinking] parse error — skipping injection: ' + (e && e.message || e) + '\\n');
      }
    }, 15);
  }
} catch (e) {
  process.stderr.write('[extended_thinking] init error: ' + (e && e.message || e) + '\\n');
}

`;
    const __shebang__ = '#!/usr/bin/env node';
      const __cjsIife__ = '(function(exports, require, module, __filename, __dirname)';
      if (code.includes(__shebang__)) {
        return code.replace(__shebang__, __shebang__ + hook);
      } else if (code.includes(__cjsIife__)) {
        return code.replace(__cjsIife__, hook + __cjsIife__);
      }
      console.warn('  [!] patch: no shebang or CJS-IIFE anchor found — skipping');
      return code;
  },
};

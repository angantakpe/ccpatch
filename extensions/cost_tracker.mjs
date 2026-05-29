// Module-level so `preloadCode` can expose it without duplication.
const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Cost Tracker
// ══════════════════════════════════════════════════════════════════════════

// Model-aware pricing lookup (rates per 1M tokens, as of 2025)
// Override via CC_PRICING_INPUT / CC_PRICING_OUTPUT (per 1M tokens)
{
  const __PRICING_TABLE__ = {
    opus:   { input: 15.00, output: 75.00 },
    sonnet: { input:  3.00, output: 15.00 },
    haiku:  { input:  0.80, output:  4.00 },
  };
  const __modelRaw__ = (
    process.env.ANTHROPIC_MODEL ||
    process.env.CLAUDE_MODEL_DISPLAY ||
    ''
  ).toLowerCase();
  const __modelKey__ = Object.keys(__PRICING_TABLE__).find(k => __modelRaw__.includes(k)) || 'sonnet';
  const __modelPricing__ = __PRICING_TABLE__[__modelKey__];

  // Per-1M-token rates (env overrides take precedence)
  const __INPUT_PER_1M__  = parseFloat(process.env.CC_PRICING_INPUT)  || __modelPricing__.input;
  const __OUTPUT_PER_1M__ = parseFloat(process.env.CC_PRICING_OUTPUT) || __modelPricing__.output;

  globalThis.__CLAUDE_COSTS__ = {
    inputTokens: 0,
    outputTokens: 0,
    lastInputTokens: 0,
    totalCost: 0,
    requests: 0,
    model: __modelKey__,
    PRICE_PER_1M_INPUT:  __INPUT_PER_1M__,
    PRICE_PER_1M_OUTPUT: __OUTPUT_PER_1M__,
    // Legacy aliases (per-1K) kept for any external consumers
    get PRICE_PER_1K_INPUT()  { return this.PRICE_PER_1M_INPUT  / 1000; },
    get PRICE_PER_1K_OUTPUT() { return this.PRICE_PER_1M_OUTPUT / 1000; },
  };
}

globalThis.__trackTokens__ = (input, output) => {
  const c = globalThis.__CLAUDE_COSTS__;
  c.inputTokens += input || 0;
  c.outputTokens += output || 0;
  c.requests++;
  c.totalCost = (c.inputTokens / 1_000_000 * c.PRICE_PER_1M_INPUT) +
                (c.outputTokens / 1_000_000 * c.PRICE_PER_1M_OUTPUT);
};

globalThis.__showCosts__ = () => {
  const c = globalThis.__CLAUDE_COSTS__;
  console.log('\\n[COSTS] Session Summary:');
  console.log('  Requests:', c.requests);
  console.log('  Input tokens:', c.inputTokens.toLocaleString());
  console.log('  Output tokens:', c.outputTokens.toLocaleString());
  console.log('  Estimated cost: ' + String.fromCharCode(36) + c.totalCost.toFixed(4));
};

process.on('exit', () => globalThis.__showCosts__?.());

// Wire: use shared fetch interceptor if available, otherwise direct fetch wrap
if (globalThis.__ccpOnFetch) {
  globalThis.__ccpOnFetch('cost_tracker', ({ isApi, events }) => {
    if (!isApi || !events) return;
    let input = 0, output = 0;
    for (const ev of events) {
      if (ev.type === 'message_start' && ev.message?.usage) { input = ev.message.usage.input_tokens || 0; if (globalThis.__CLAUDE_COSTS__) globalThis.__CLAUDE_COSTS__.lastInputTokens = input; }
      if (ev.type === 'message_delta' && ev.usage) output = ev.usage.output_tokens || 0;
    }
    if (input || output) globalThis.__trackTokens__?.(input, output);
  });
} else {
  // Fallback: direct fetch wrapper if fetch_interceptor patch is not active
  const __costOrigFetch__ = globalThis.fetch;
  globalThis.fetch = async function trackedFetch(url, options) {
    const resp = await __costOrigFetch__.apply(this, arguments);
    const isApi = String(url?.url || url || '').includes('anthropic.com') && options?.method === 'POST';
    if (!isApi || !resp.ok || !resp.body) return resp;
    const tee = resp.body.tee();
    const reader = tee[1].getReader();
    const dec = new TextDecoder();
    (async () => {
      try {
        let input = 0, output = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value, { stream: true }).split('\\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'message_start' && ev.message?.usage) { input = ev.message.usage.input_tokens || 0; if (globalThis.__CLAUDE_COSTS__) globalThis.__CLAUDE_COSTS__.lastInputTokens = input; }
              if (ev.type === 'message_delta' && ev.usage) output = ev.usage.output_tokens || 0;
            } catch(e) {}
          }
        }
        if (input || output) globalThis.__trackTokens__?.(input, output);
      } catch(e) {}
    })();
    return new Response(tee[0], { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  };
}

`;

export default {
  category: 'observe',

  description: 'Track and display token usage and estimated costs',
  capabilities: ["network"],
  verify: { present: '__CLAUDE_COSTS__', count: { present: 7 } },
  dependsOn: ['fetch_interceptor'],
  preload: true,
  preloadCode: hook,
  apply: (code) => {
    return code.replace('(function(exports, require, module, __filename, __dirname) {', '(function(exports, require, module, __filename, __dirname) {' + hook);
  },
};

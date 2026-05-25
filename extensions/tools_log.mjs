// Module-level so `preloadCode` can expose it without duplication.
const logHook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Tool Call Logger
// ══════════════════════════════════════════════════════════════════════════

globalThis.__CLAUDE_TOOL_LOG__ = globalThis.__CLAUDE_TOOL_LOG__ || [];

// Register SSE after-subscriber to capture tool_use events from API responses
var __toolParamBuf__ = new Map(); // tool_use_id -> accumulated partial_json
if (typeof globalThis.__ccpOnFetch === 'function') {
  globalThis.__ccpOnFetch('tools_log', function({ isApi, events, options }) {
    if (!isApi || !events) return;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        var entry = {
          timestamp: new Date().toISOString(),
          tool: ev.content_block.name,
          id: ev.content_block.id,
          params: null,
        };
        globalThis.__CLAUDE_TOOL_LOG__.push(entry);
        __toolParamBuf__.set(ev.content_block.id, { entry: entry, json: '' });
        try { process.stderr.write('[TOOL] ' + ev.content_block.name + ' (' + ev.content_block.id + ')\\n'); } catch(e) {}
      }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
        var buf = __toolParamBuf__.get(ev.index !== undefined ? null : null) || __toolParamBuf__.get(ev.content_block_id);
        // Accumulate by iterating — delta events carry index not id directly
        __toolParamBuf__.forEach(function(v, k) {
          // Only one active tool_use at a time; append to last open entry
          if (v.entry.params === null) v.json += ev.delta.partial_json;
        });
      }
      if (ev.type === 'content_block_stop') {
        __toolParamBuf__.forEach(function(v, k) {
          if (v.entry.params === null && v.json.length > 0) {
            try {
              v.entry.params = JSON.parse(v.json);
            } catch(e) {
              v.entry.params = v.json;
            }
            __toolParamBuf__.delete(k);
          }
        });
      }
    }
  });
} else {
  // Fallback: expose __logToolCall__ for manual instrumentation
  globalThis.__logToolCall__ = function(toolName, params, result) {
    var entry = {
      timestamp: new Date().toISOString(),
      tool: toolName,
      params: params,
      result: typeof result === 'string' ? result.slice(0, 500) : result
    };
    globalThis.__CLAUDE_TOOL_LOG__.push(entry);
    try { process.stderr.write('[TOOL] ' + toolName + ' ' + JSON.stringify(params || {}).slice(0, 200) + '\\n'); } catch(e) {}
  };
}

`;

export default {
  category: 'observe',

  description: 'Log all tool calls and results via SSE event subscriber',
  capabilities: ["network","fs","telemetry"],
  verify: { present: '__CLAUDE_TOOL_LOG__' },
  dependsOn: ['fetch_interceptor'],
  preload: true,
  preloadCode: logHook,
  apply: (code) => {
    const _SHEBANG_ = '#!/usr/bin/env node';
    const _CJS_IIFE_ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(_SHEBANG_)) return code.replace(_SHEBANG_, _SHEBANG_ + '\n' + logHook);
    if (code.includes(_CJS_IIFE_)) return code.replace(_CJS_IIFE_, () => logHook + _CJS_IIFE_);
    console.warn('  [!] tools_log: anchor not found — skipping');
    return code;
  },
};

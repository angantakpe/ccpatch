/**
 * assistant_stream_events — Re-publish Anthropic streaming response events to
 * __ccpBus so external bridges (e.g. headless_bridge) can stream the
 * assistant's reply text in real time without scraping the terminal.
 *
 * Emitted topics:
 *   turn.start        { input_tokens? }
 *   assistant.text    { text }       — per content_block_delta
 *   assistant.thinking{ text }       — extended-thinking delta
 *   tool.use          { id, name }   — tool_use block start (header only)
 *   turn.end          { stop_reason?, output_tokens? }
 *
 * Driven via fetch_interceptor's per-event stream hook (__ccpOnFetchStream),
 * so only one tap is installed across all subscribers.
 */
export default {
  category: 'feature',
  description: 'Re-emit Anthropic SSE message events to __ccpBus.',
  capabilities: ['telemetry'],
  dependsOn: ['fetch_interceptor', 'event_bus'],
  verify: { present: '__ccpAssistantStream_v1', count: { present: 2 } },
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] assistant_stream_events — re-emit /v1/messages SSE to __ccpBus
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpAssistantStream_v1) return;
  globalThis.__ccpAssistantStream_v1 = true;
  if (typeof globalThis.__ccpOnFetchStream !== 'function') return;
  globalThis.__ccpOnFetchStream('assistant_stream_events', (ev) => {
    const bus = globalThis.__ccpBus;
    if (!bus || !ev || typeof ev !== 'object') return;
    try {
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message && ev.message.usage;
          bus.emit('turn.start', { input_tokens: u && u.input_tokens });
          return;
        }
        case 'content_block_start': {
          const b = ev.content_block;
          if (b && b.type === 'tool_use') {
            bus.emit('tool.use', { id: b.id, name: b.name });
          }
          return;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (!d) return;
          if (d.type === 'text_delta' && d.text) {
            bus.emit('assistant.text', { text: d.text });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            bus.emit('assistant.thinking', { text: d.thinking });
          }
          return;
        }
        case 'message_delta': {
          const u = ev.usage;
          bus.emit('turn.end', {
            stop_reason: ev.delta && ev.delta.stop_reason,
            output_tokens: u && u.output_tokens,
          });
          return;
        }
        default:
          return;
      }
    } catch (_) {}
  });
})();
`;
    const m = code.match(/\(function\(exports, require, module, __filename, __dirname\)\s*\{/);
    if (m) {
      const idx = m.index + m[0].length;
      return code.slice(0, idx) + '\n' + hook + '\n' + code.slice(idx);
    }
    const SHEBANG = '#!/usr/bin/env node';
    if (code.includes(SHEBANG)) return code.replace(SHEBANG, () => SHEBANG + '\n' + hook);
    console.warn('  [!] assistant_stream_events: anchor not found — skipping');
    return code;
  },
};

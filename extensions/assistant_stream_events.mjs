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
 *
 * ── Auxiliary (non-conversation) calls are filtered out ─────────────────────
 *
 * Confirmed live 2026-08-21 (packages/gateway/README.md's "Status" section
 * carried this as an open issue before this fix): Claude Code makes many
 * internal API calls beyond the human-facing conversation turn — title
 * generation, branch naming, session naming, hook prompts, repl sampling,
 * etc. (grep the extracted bundle for `querySource` to see the ~30 internal
 * call sites). Before this fix, every one of them streamed through the same
 * SSE tap and got re-emitted as ordinary `assistant.text`, so a bridge
 * consumer had no way to tell "the real answer" from "a title-generation
 * call's `{"title": "..."}` JSON fragment" — confirmed live: a real turn's
 * accumulated text included exactly that kind of stray JSON.
 *
 * The reliable signal, traced through the extracted bundle (storage/archives/
 * claude-code-v2.1.191/cli.v2.1.191.cjs) AND confirmed against the real wire
 * request body (dumped live via a temporary __ccpOnFetchBefore probe — first
 * attempt anchored on a top-level `format` field, which is WRONG and caught
 * nothing; the real field is nested): every one of those internal calls
 * passes `outputFormat: {type:"json_schema", schema:{...}}`, which — when the
 * model supports the `structured_outputs` beta — ends up as
 *   body.output_config.format === {type:"json_schema", schema:{...}}
 * on the actual `/v1/messages` request. That's a real Anthropic API wire
 * field, not a minified internal identifier, so it is safe to anchor
 * detection logic on. The main conversation turn's `output_config` is present
 * but has no `format` key — a human-facing reply is free text, not
 * schema-constrained JSON. fetch_interceptor.mjs's stream-subscriber callback
 * now receives that request's `{ url, options }` as a third argument
 * specifically so this filter is possible; see its own comment above
 * `__ccpOnFetchStream`.
 *
 * Known gap: if a model does NOT support the `structured_outputs` beta, the
 * bundle silently skips setting `output_config.format` even though
 * `outputFormat` was requested (there's a capability gate at the same call
 * site) — on such a model, that auxiliary call's text would NOT be filtered
 * and could still leak through. Not observed on Sonnet 4.6 (the model used
 * for the live verification above), where structured output is supported.
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
  // Cache the aux-call decision per request (meta.options is the same object
  // reference for every event of one stream), so a long turn only pays for
  // one JSON.parse of the request body, not one per delta.
  const __ccpAuxCallCache = new WeakMap();
  const __ccpIsAuxCall = (meta) => {
    if (!meta || !meta.options) return false;
    if (__ccpAuxCallCache.has(meta.options)) return __ccpAuxCallCache.get(meta.options);
    let aux = false;
    try {
      const body = typeof meta.options.body === 'string' ? JSON.parse(meta.options.body) : null;
      // Confirmed live 2026-08-21: the field is nested under output_config,
      // not top-level — { output_config: { format: { type:"json_schema", … } } }.
      aux = !!(body && body.output_config && body.output_config.format);
    } catch (_) {}
    __ccpAuxCallCache.set(meta.options, aux);
    return aux;
  };
  globalThis.__ccpOnFetchStream('assistant_stream_events', (ev, _abortFn, meta) => {
    const bus = globalThis.__ccpBus;
    if (!bus || !ev || typeof ev !== 'object') return;
    // Structured-output side-call (title/branch/session-name generation, hook
    // prompts, repl sampling, ...) — not the human-facing conversation turn.
    // See this module's header for how 'format' was traced as the signal.
    if (__ccpIsAuxCall(meta)) return;
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
    // Idempotency guard (rule 2): the hook sets this sentinel global; if it's
    // already present the bundle is patched — return unchanged.
    if (code.includes('__ccpAssistantStream_v1')) return code;
    const m = code.match(/\(function\(exports, require, module, __filename, __dirname\)\s*\{/);
    if (m) {
      const idx = m.index + m[0].length;
      return code.slice(0, idx) + '\n' + hook + '\n' + code.slice(idx);
    }
    const SHEBANG = '#!/usr/bin/env node';
    if (code.startsWith(SHEBANG)) return code.replace(SHEBANG, () => SHEBANG + '\n' + hook);
    console.warn('  [!] assistant_stream_events: anchor not found — skipping');
    return code;
  },
};

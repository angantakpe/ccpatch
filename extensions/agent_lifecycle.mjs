import { spliceBoot } from '../runner/patch-helpers.mjs';

export default {
  category: 'infrastructure',
  description: 'Emits turn.start/turn.end/agent.spawn/agent.exit on __ccpBus by hooking the fetch interceptor stream.',
  capabilities: ['telemetry'],
  dependsOn: ['event_bus', 'fetch_interceptor'],
  verify: { present: '__ccpAgentLifecycle_v1', count: { present: 2 } },
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] agent_lifecycle — turn/agent event producer for __ccpBus
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpAgentLifecycle_v1) return;
  globalThis.__ccpAgentLifecycle_v1 = true;

  const bus = () => globalThis.__ccpBus;
  const emit = (topic, payload) => {
    const b = bus();
    if (b) try { b.emit(topic, payload); } catch (_) {}
  };

  // Each streaming API call is one turn. We track in-flight turns by a
  // counter-based id so concurrent sub-agent turns stay distinct.
  let _seq = 0;

  globalThis.__ccpOnFetch && globalThis.__ccpOnFetch('agent_lifecycle_after', ({ url, options, isApi, events }) => {
    if (!isApi || !events) return;

    const id = String(++_seq);
    const ts = Date.now();

    // Derive usage from the message_delta stop event if present.
    let usage = null;
    if (Array.isArray(events)) {
      for (const ev of events) {
        if (ev && ev.type === 'message_delta' && ev.usage) {
          usage = {
            in: ev.usage.input_tokens || 0,
            out: ev.usage.output_tokens || 0,
            cache_read: ev.usage.cache_read_input_tokens || 0,
            cache_write: ev.usage.cache_creation_input_tokens || 0,
          };
        }
      }
    }

    emit('turn.start', { id, ts });
    emit('turn.end', { id, ts: Date.now(), usage });
  });

  // Subagent spawn/exit are surfaced through __ccpSubagent when expose_agent_tool
  // is loaded. Bridge those events onto __ccpBus so agent_tree can consume them
  // without a direct dependency on expose_agent_tool.
  const bridgeSubagent = () => {
    const sub = globalThis.__ccpSubagent;
    if (!sub || sub.__ccpLifecycleBridged) return;
    sub.__ccpLifecycleBridged = true;
    sub.on('spawn', (p) => {
      if (!p) return;
      emit('agent.spawn', { parent_id: p.parent_id || null, child_id: p.child_id || p.id, prompt: p.prompt || null });
    });
    sub.on('exit', (p) => {
      if (!p) return;
      emit('agent.exit', { id: p.id, ok: p.ok !== false, usage: p.usage || null });
    });
  };

  // __ccpSubagent may arrive after this patch runs (load-order variability).
  bridgeSubagent();
  const _origDefProp = Object.defineProperty;
  try {
    _origDefProp(globalThis, '__ccpSubagent', {
      configurable: true,
      get() { return this.__ccpSubagentVal; },
      set(v) {
        this.__ccpSubagentVal = v;
        if (v) bridgeSubagent();
      },
    });
  } catch (_) {}
})();
`;
    return spliceBoot(code, hook);
  },
};

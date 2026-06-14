import { spliceBoot } from '../runner/patch-helpers.mjs';

export default {
  category: 'infrastructure',
  description: 'Emits turn.start/turn.end/agent.spawn/agent.exit on __ccpBus by hooking the fetch interceptor stream.',
  capabilities: ['telemetry'],
  dependsOn: ['event_bus', 'fetch_interceptor'],
  verify: { present: '__ccpAgentLifecycle_v1', count: { present: 2 } },
  // Shared boot-anchor prepend with the other orchestration-bus patches — see the
  // note in event_bus.mjs. Mutual acknowledgement of intended co-location.
  allowOverlapWith: ['event_bus', 'auth_token', 'agent_tree'],
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
  //
  // turn.start fires from the BEFORE hook (request dispatch) and turn.end from
  // the AFTER hook (stream complete), so the two timestamps actually bracket the
  // turn instead of both being stamped at completion. The pair is correlated by
  // the per-call options object (each fetch carries its own), stashed in a
  // WeakMap so concurrent turns don't cross-talk and entries can't leak.
  let _seq = 0;
  const _pending = new WeakMap(); // options object -> { id, startTs }

  globalThis.__ccpOnFetchBefore && globalThis.__ccpOnFetchBefore('agent_lifecycle_before', (ctx) => {
    if (!ctx || !ctx.isApi) return;
    const id = String(++_seq);
    const startTs = Date.now();
    if (ctx.options && typeof ctx.options === 'object') {
      _pending.set(ctx.options, { id, startTs });
    }
    emit('turn.start', { id, ts: startTs });
    // Return nothing — a truthy return would short-circuit the real fetch.
  });

  globalThis.__ccpOnFetch && globalThis.__ccpOnFetch('agent_lifecycle_after', ({ options, isApi, events }) => {
    if (!isApi) return;

    // Recover the turn opened in the before hook; fall back to a fresh id if the
    // pairing was lost (e.g. a before-subscriber replaced the options object, or
    // the before hook never ran because another patch isn't present).
    const rec = (options && typeof options === 'object') ? _pending.get(options) : null;
    if (rec) _pending.delete(options);

    // Non-streaming or failed responses carry no events. Still close any turn the
    // before hook opened so every turn.start has a matching turn.end.
    if (!events) {
      if (rec) emit('turn.end', { id: rec.id, ts: Date.now(), ms: Date.now() - rec.startTs, usage: null });
      return;
    }

    const id = rec ? rec.id : String(++_seq);
    const startTs = rec ? rec.startTs : Date.now();
    // No before hook ran for this turn — emit a start so the pair stays intact.
    if (!rec) emit('turn.start', { id, ts: startTs });

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

    const endTs = Date.now();
    emit('turn.end', { id, ts: endTs, ms: endTs - startTs, usage });
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

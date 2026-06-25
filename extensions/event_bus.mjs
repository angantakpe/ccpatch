/**
 * event_bus — typed pub/sub on top of __ccpProvide/__ccpRequire.
 *
 * Topics (versioned; payload shape stable within a major version):
 *   turn.start   { id, ts, request? }
 *   turn.end     { id, ts, usage, request? }
 *   tool.call    { id, agent_path, name, input, request? }
 *   tool.result  { id, agent_path, name, ok, bytes, request? }
 *   agent.spawn  { parent_id, child_id, prompt }
 *   agent.exit   { id, ok, usage }
 *   cost.delta   { in, out, cache_read, cache_write, usd, agent_path? }
 *
 * Subscribers can pass an exact topic ("tool.call") or a glob ("tool.*", "*").
 * Glob matches are O(globs) per emit — keep glob subscriber counts low.
 *
 * No bundle anchor required; injected at the CJS-IIFE seam.
 */
export default {
  category: 'infrastructure',
  description: 'Typed pub/sub event bus exposed as __ccpBus.',
  capabilities: ['telemetry'],
  // Injected hook references the sentinel twice (idempotency guard + assignment),
  // so a single clean apply yields exactly 2 occurrences. count>2 ⇒ double-applied.
  verify: { present: '__ccpBus_v1', count: { present: 2 } },
  // These four orchestration-bus patches (event_bus, auth_token, agent_lifecycle,
  // agent_tree) each PREPEND their own independent, self-bootstrapping boot block
  // at the shared shebang / CJS-IIFE anchor. The overlap detector flags their
  // common insertion range (diff-vs-diff) whenever a profile composes them — the
  // `platform` profile composes all four; `orchestrator` composes three. The
  // blocks do not clobber each other (each guards its own __ccp* global), so the
  // co-location is intended; acknowledge it mutually.
  allowOverlapWith: ['auth_token', 'agent_lifecycle', 'agent_tree'],
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] event_bus — globalThis.__ccpBus
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpBus_v1) return;
  globalThis.__ccpBus_v1 = true;
  const exact = new Map();   // topic -> Set<fn>
  const globs = new Set();   // { re, fn }
  // Build a glob regex by escaping all special chars EXCEPT '*' (handled
  // separately by splitting). Splitting on '*' lets a topic of bare '*'
  // produce '^.*$' instead of an invalid '^*$'.
  const escapeReSeg = (s) => s.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  const globToRe = (g) => new RegExp('^' + g.split('*').map(escapeReSeg).join('.*') + '$');
  globalThis.__ccpBus = {
    on(topic, fn) {
      if (typeof fn !== 'function') return () => {};
      if (topic.includes('*')) {
        const re = globToRe(topic);
        const entry = { re, fn };
        globs.add(entry);
        return () => globs.delete(entry);
      }
      let set = exact.get(topic);
      if (!set) { set = new Set(); exact.set(topic, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(topic, payload) {
      const set = exact.get(topic);
      if (set) for (const fn of set) { try { fn(payload, topic); } catch (_) {} }
      if (globs.size) for (const { re, fn } of globs) {
        if (re.test(topic)) { try { fn(payload, topic); } catch (_) {} }
      }
    },
    topics() { return [...exact.keys()]; },
  };
  if (typeof globalThis.__ccpProvide === 'function') {
    try {
      globalThis.__ccpProvide('bus', {
        version: 1,
        producer: 'event_bus',
        shape: ['on', 'emit', 'topics'],
        value: globalThis.__ccpBus,
      });
    } catch (_) {}
  }
})();
`;
    // Idempotency guard (rule 2): the hook sets this sentinel global; if it's
    // already present the bundle is patched — return unchanged.
    if (code.includes('__ccpBus_v1')) return code;
    const SHEBANG = '#!/usr/bin/env node';
    const IIFE = '(function(exports, require, module, __filename, __dirname)';
    // Use the function form so `$&`/`$'`/`$$` inside `hook` (regex source) are
    // treated literally rather than as String.prototype.replace specials.
    if (code.startsWith(SHEBANG)) return code.replace(SHEBANG, () => SHEBANG + '\n' + hook);
    if (code.includes(IIFE)) return code.replace(IIFE, () => hook + IIFE);
    console.warn('  [!] event_bus: anchor not found — skipping');
    return code;
  },
};

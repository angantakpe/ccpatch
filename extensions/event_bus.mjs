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
  verify: { present: '__ccpBus_v1', count: { present: 1 } },
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
    const SHEBANG = '#!/usr/bin/env node';
    const IIFE = '(function(exports, require, module, __filename, __dirname)';
    // Use the function form so `$&`/`$'`/`$$` inside `hook` (regex source) are
    // treated literally rather than as String.prototype.replace specials.
    if (code.includes(SHEBANG)) return code.replace(SHEBANG, () => SHEBANG + '\n' + hook);
    if (code.includes(IIFE)) return code.replace(IIFE, () => hook + IIFE);
    console.warn('  [!] event_bus: anchor not found — skipping');
    return code;
  },
};

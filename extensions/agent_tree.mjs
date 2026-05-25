/**
 * agent_tree — parent→child tree of subagent spawns with per-node usage
 * and tool-call accounting. Pure consumer of __ccpBus events; exposes
 * __ccpAgentTree for inspection by other extensions or the headless bridge.
 *
 * Bus topics consumed:
 *   agent.spawn  { parent_id, child_id, prompt }
 *   agent.exit   { id, ok, usage }
 *   tool.call    { agent_path, name }
 *   cost.delta   { agent_path?, in, out, cache_read, cache_write, usd }
 *
 * Snapshot shape (recursive):
 *   { id, parent, prompt, started_at, ended_at, ok,
 *     usage: { in, out, cache_read, cache_write, usd },
 *     tools: { [name]: count },
 *     children: [ ...nodes ] }
 */
export default {
  category: 'vertical',
  description: 'Per-subagent cost + tool accounting tree exposed as __ccpAgentTree.',
  capabilities: ['telemetry'],
  dependsOn: ['event_bus'],
  verify: { present: '__ccpAgentTree_v1' },
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] agent_tree — globalThis.__ccpAgentTree
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpAgentTree_v1) return;
  globalThis.__ccpAgentTree_v1 = true;
  const nodes = new Map();          // id -> node
  let rootId = null;
  const ensure = (id, parent) => {
    let n = nodes.get(id);
    if (!n) {
      n = {
        id, parent: parent || null, prompt: null,
        started_at: Date.now(), ended_at: null, ok: null,
        usage: { in: 0, out: 0, cache_read: 0, cache_write: 0, usd: 0 },
        tools: Object.create(null),
        children: [],
      };
      nodes.set(id, n);
      if (parent && nodes.get(parent)) nodes.get(parent).children.push(id);
      else if (!rootId) rootId = id;
    }
    return n;
  };
  const tailOf = (path) => (path || '').split('/').filter(Boolean).pop();
  const bus = globalThis.__ccpBus;
  if (bus) {
    bus.on('agent.spawn', (p) => {
      if (!p || !p.child_id) return;
      const n = ensure(p.child_id, p.parent_id);
      if (p.prompt != null) n.prompt = p.prompt;
    });
    bus.on('agent.exit', (p) => {
      if (!p || !p.id) return;
      const n = ensure(p.id);
      n.ended_at = Date.now();
      n.ok = !!p.ok;
      if (p.usage) {
        for (const k of Object.keys(n.usage)) {
          if (p.usage[k] != null) n.usage[k] += p.usage[k];
        }
      }
    });
    bus.on('tool.call', (p) => {
      const id = tailOf(p && p.agent_path) || 'root';
      const n = ensure(id);
      n.tools[p.name] = (n.tools[p.name] || 0) + 1;
    });
    bus.on('cost.delta', (p) => {
      if (!p) return;
      const id = tailOf(p.agent_path) || 'root';
      const n = ensure(id);
      for (const k of Object.keys(n.usage)) {
        if (p[k] != null) n.usage[k] += p[k];
      }
    });
  }
  const inflate = (id) => {
    const n = nodes.get(id);
    if (!n) return null;
    return Object.assign({}, n, { children: n.children.map(inflate).filter(Boolean) });
  };
  globalThis.__ccpAgentTree = {
    snapshot() { return rootId ? inflate(rootId) : null; },
    flat() { return [...nodes.values()]; },
    get(id) { return nodes.get(id) || null; },
    reset() { nodes.clear(); rootId = null; },
    subscribe(cb) {
      if (!bus || typeof cb !== 'function') return () => {};
      return bus.on('agent.exit', () => {
        try { cb(globalThis.__ccpAgentTree.snapshot()); } catch (_) {}
      });
    },
  };
  if (typeof globalThis.__ccpProvide === 'function') {
    try {
      globalThis.__ccpProvide('agentTree', {
        version: 1,
        producer: 'agent_tree',
        shape: ['snapshot', 'flat', 'get', 'reset', 'subscribe'],
        value: globalThis.__ccpAgentTree,
      });
    } catch (_) {}
  }
})();
`;
    const SHEBANG = '#!/usr/bin/env node';
    const IIFE = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(SHEBANG)) return code.replace(SHEBANG, SHEBANG + '\n' + hook);
    if (code.includes(IIFE)) return code.replace(IIFE, () => hook + IIFE);
    console.warn('  [!] agent_tree: anchor not found — skipping');
    return code;
  },
};

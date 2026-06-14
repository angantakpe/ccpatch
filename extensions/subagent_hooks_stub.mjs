export default {
  category: 'infrastructure',

  description: 'No-op stub publishing the __ccpSubagent event-bus contract for patches that subscribe to subagent lifecycle.',
  capabilities: [],
  verify: { present: '__ccpSubagentStubInstalled', count: { present: 1 } },
  apply: (code) => {
    if (code.includes('__ccpSubagentStubInstalled')) return code;

    const hook = `
// ── [PATCH] Subagent Hooks Stub — no-op event bus ────────────────────────
// Publishes the __ccpSubagent contract so patches that depend on it
// (expose_agent_tool, etc.) can emit safely.
if (!globalThis.__ccpSubagent) {
  globalThis.__ccpSubagent = {
    emit: function() {},
    on: function() { return function() {}; },
    once: function() { return function() {}; },
  };
  globalThis.__ccpSubagentStubInstalled = true;
  // Register the subagent event bus as a typed contract so consumers
  // (expose_agent_tool, etc.) get a loud, actionable error instead of a silent
  // \`undefined\` when this producer is disabled. Bare global kept for back-compat.
  // Fail-open so a missing/older contract kernel never breaks the CLI.
  if (typeof globalThis.__ccpProvide === 'function') {
    try {
      globalThis.__ccpProvide('subagent', {
        version: 1,
        producer: 'subagent_hooks_stub',
        shape: ['emit', 'on', 'once'],
        value: globalThis.__ccpSubagent,
      });
    } catch (_) {}
  }
}
`;

    const shebang = '#!/usr/bin/env node';
    const cjsIife = '(function(exports, require, module, __filename, __dirname) {';
    if (code.startsWith(shebang)) {
      return code.replace(shebang, shebang + hook);
    } else if (code.includes(cjsIife)) {
      return code.replace(cjsIife, () => cjsIife + hook);
    }
    console.warn('  [!] subagent_hooks_stub: anchor not found — skipping');
    return code;
  },
};

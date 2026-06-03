/**
 * _agents_dir_example — demonstrates the `agentDir: { name, code }` opt-in.
 *
 * Disabled by default. apply() is a no-op: all logic ships as an independent
 * file inside the `ccpatch-agents/` sibling directory, loaded at startup by
 * the agents-dir block injected by core/overlay_loader.
 *
 * The runner collects `agentDir` entries via runner/agents-dir-builder.mjs and
 * writes each as `ccpatch-agents/<name>.mjs` next to the patched bundle.
 * Integrity is verified via a `.sha256` sidecar before the file is require()d.
 *
 * The leading underscore marks this as a documentation example — the patch
 * verification test loop skips it automatically.
 */

export default {
  name: '_agents_dir_example',
  version: '1.0.0',
  category: 'optional',
  description: 'Example: ship an ADK agent as a ccpatch-agents/ entry loaded at startup.',
  capabilities: [],
  enabled: false,
  verify: { present: '#!/usr/bin/env node', weak: true },
  agentDir: {
    name: 'hello-agent',
    code: `return { name: 'hello-agent', async activate(ctx) { /* ADK agent body */ } }`,
  },
  apply: (code) => code,
};

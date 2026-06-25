/**
 * adk_hello_agent — wire the experimental ADK into a patched session.
 *
 * This is the first patch to actually *load* `@codehornets/adk` inside a live
 * Claude Code process. It carries no bundle anchor: `apply()` is a no-op. All
 * logic ships as the `agentDir.code` body below, which the runner writes to
 *   <bundle-dir>/ccpatch-agents/adk-hello.mjs
 * and the core/overlay_loader boot block require()s at startup. That boot block
 * integrity-checks this stub against its emitted .sha256 sidecar AND verifies
 * every ccpatch-adk/*.mjs runtime file against its own sidecar BEFORE this stub
 * is loaded — so the import('../ccpatch-adk/index.mjs') below only ever resolves
 * a runtime that already passed a hash check (a mismatch aborts all agent loads).
 *
 * Delivery: cmd-build.mjs copies the ADK runtime to <bundle-dir>/ccpatch-adk/
 * whenever any agentDir patch is enabled, so the body resolves the ADK from a
 * path next to the bundle — no npm install-layout assumption.
 *
 * Load ordering (all in the overlay_loader boot block, after the expose_* shims
 * have registered their __ccp* globals):
 *   1. require() this file → runs the synchronous prologue
 *   2. dynamic import() of the ESM ADK (require can't load ESM directly)
 *   3. capabilities() preflight → only register what the live patches support
 *
 * The agent body is intentionally defensive: a missing/drifted primitive
 * degrades to a logged skip, never a boot crash. That mirrors the ADK README's
 * "always call capabilities() to preflight" contract.
 */

const AGENT_CODE = `
// ccpatch-agents/adk-hello.mjs — generated from extensions/adk_hello_agent.mjs.
// Loaded at boot by the core/overlay_loader agents-dir block. The loader uses
// require(), which under the Bun bundle (and Node's CJS) can pull in an .mjs;
// we resolve the sibling ADK via import.meta.url so this works whether the host
// scope provides require/__dirname or not (Bun bundle, Node ESM fallback, and
// the standalone integrity-simulation harness).
'use strict';

(async () => {
  // The ADK runtime is copied to <bundle-dir>/ccpatch-adk/ by the build. This
  // file lives in <bundle-dir>/ccpatch-agents/, so the ADK is one dir up.
  const adkEntry = new URL('../ccpatch-adk/index.mjs', import.meta.url).href;
  let adk;
  try {
    adk = await import(adkEntry);
  } catch (e) {
    process.stderr.write('[adk-hello] could not import ADK runtime: ' + (e && e.message) + '\\n');
    return;
  }

  const { defineAgent, defineTool } = adk;

  // Persona registration is always safe (it touches only ADK-local state).
  try {
    defineAgent({
      name: 'adk-hello',
      description: 'Smoke-test agent proving the ADK is wired into a patched session.',
      systemPrompt: 'You are adk-hello, a minimal ADK demo agent.',
      tools: ['adk_ping'],
    });
  } catch (e) {
    process.stderr.write('[adk-hello] defineAgent failed: ' + (e && e.message) + '\\n');
  }

  // defineTool polls for __ccpRawTools / __ccpRegisterTool for ~5s after boot,
  // so no boot-time capabilities() guard is needed — the globals are set by the
  // expose_tool_dispatch injection block that runs after this agents-dir IIFE.
  try {
    const handle = defineTool({
      name: 'adk_ping',
      description: 'Returns a pong proving an ADK-injected tool is live in this session.',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string', description: 'optional echo string' } },
      },
      execute: (input) => 'adk_ping pong: ' + (input && input.msg ? String(input.msg) : 'ok'),
    });
    const live = await handle.ready;
    process.stderr.write('[adk-hello] adk_ping injected=' + live + '\\n');
  } catch (e) {
    process.stderr.write('[adk-hello] defineTool failed: ' + (e && e.message) + '\\n');
  }
})().catch((e) => {
  try { process.stderr.write('[adk-hello] fatal: ' + (e && e.message) + '\\n'); } catch (_) {}
});
`;

export default {
  name: 'adk_hello_agent',
  version: '0.1.0',
  category: 'optional',
  description: 'Load @codehornets/adk into a patched session and register a hello agent + adk_ping tool.',
  // Injects a tool into the live tool array via the ADK → expose_tool_dispatch.
  capabilities: ['tools'],
  // Hard deps: the ADK reads these patches' exposed globals/contracts. The
  // runner enforces these are present and ordered before this patch.
  dependsOn: ['expose_tool_dispatch', 'expose_system_prompt'],
  enabled: false,
  // No bundle mutation: all behavior ships in the emitted ccpatch-agents/adk-hello.mjs
  // file, not in cli.js. apply() is intentionally a no-op, so we MUST NOT declare a
  // verify.present literal — that would make the runner treat the (correct) no-change
  // as anchor drift and force-fail the build (see runner/apply-pipeline.mjs:188). An
  // absent-only verify describes a desired end state ("this sentinel is not in the
  // bundle"), which the runner exempts from the no-change-is-fatal gate. The agentDir
  // file's own integrity is guaranteed by its emitted .sha256 sidecar at load time.
  verify: { absent: '__ccp_adk_hello_should_never_be_in_bundle__' },
  agentDir: {
    name: 'adk-hello',
    code: AGENT_CODE,
  },
  apply: (code) => code,
};

/**
 * adk_handoff_demo — the END-TO-END reference consumer for the ADK handoff surface.
 *
 * `adk_hello_agent` only proves the persona→tool path (defineAgent + defineTool).
 * A lot of the ADK's most security-sensitive machinery — `defineHandoff` (delegate
 * AND swap), the `AgentRouter`, and the cross-process `createMemory` store — shipped
 * "wired at the capability level but consumed by no patch" (see
 * packages/adk/REVIEW.md §7). This patch closes that gap: it is the single shipped
 * consumer that drives every one of those surfaces through a real patched session,
 * so the TOCTOU pins, swap LIFO stack, and persona-overlay scoping are exercised in
 * situ and not only by their own unit tests.
 *
 * Like adk_hello_agent it carries NO bundle anchor: `apply()` is a no-op and all
 * behavior ships as the `agentDir.code` body, which the runner writes to
 *   <bundle-dir>/ccpatch-agents/adk-handoff-demo.mjs
 * and core/overlay_loader require()s at boot AFTER the expose_* shims have
 * registered their __ccp* globals and AFTER each ccpatch-adk/*.mjs runtime file has
 * passed its .sha256 integrity check. The body resolves the ADK from the sibling
 * <bundle-dir>/ccpatch-adk/ that cmd-build.mjs copies in whenever an agentDir
 * patch is enabled — no npm install-layout assumption.
 *
 * SAFETY MODEL. Registering a swap target grants it the right to become the live
 * persona (a privilege-escalation surface — see the ADK README "Trust" section).
 * This demo therefore:
 *   - registers only LOCAL, inert personas (no secrets, no tool grants beyond the
 *     demo's own tool);
 *   - constrains the swap with `allowSwapTargets` so the swap can only ever flip to
 *     the one demo persona it defines;
 *   - does NOT auto-start the AgentRouter (which would inject a *user* message and
 *     steer the live session). It only REGISTERS the router so the wiring is proven
 *     reachable; the operator drives it explicitly. Auto-driving the session at boot
 *     would be a hostile default.
 *   - keys its memory store under a demo-local relative path inside the project
 *     sandbox, never an absolute/traversing path.
 *
 * Every step is capability-gated via `capabilities()` and wrapped so a missing or
 * drifted primitive degrades to a logged skip — never a boot crash. That mirrors
 * the ADK README's "always call capabilities() to preflight" contract and the
 * adk_hello_agent precedent.
 */

const AGENT_CODE = `
// ccpatch-agents/adk-handoff-demo.mjs — generated from extensions/adk_handoff_demo.mjs.
// Loaded at boot by the core/overlay_loader agents-dir block, AFTER the expose_*
// shims have registered their __ccp* globals. Resolves the sibling ADK runtime via
// import.meta.url so it works whether the host provides require/__dirname or not.
'use strict';

(async () => {
  const log = (m) => { try { process.stderr.write('[adk-handoff-demo] ' + m + '\\n'); } catch (_) {} };

  // The ADK runtime is copied to <bundle-dir>/ccpatch-adk/ by the build. This file
  // lives in <bundle-dir>/ccpatch-agents/, so the ADK is one dir up.
  let adk;
  try {
    adk = await import(new URL('../ccpatch-adk/index.mjs', import.meta.url).href);
  } catch (e) {
    log('could not import ADK runtime: ' + (e && e.message));
    return;
  }

  const { defineAgent, defineHandoff, AgentRouter, createMemory, capabilities } = adk;

  let caps;
  try {
    caps = capabilities();
  } catch (e) {
    log('capabilities() threw: ' + (e && e.message));
    return;
  }

  // ── personas (always safe — touches only ADK-local registry state) ──────────
  // Define the demo's source + target personas up front. defineAgent is the only
  // step that is always safe regardless of which __ccp* primitives are live, and
  // it must run BEFORE defineHandoff({mode:'swap'}) so the swap can pin the
  // target's systemPrompt sha256 at definition time (the TOCTOU guard).
  try {
    defineAgent({
      name: 'adk-demo-source',
      description: 'ADK handoff demo — the agent that initiates a transfer.',
      systemPrompt: 'You are adk-demo-source, the originating ADK demo persona.',
      tools: ['adk_demo_noop'],
    });
    defineAgent({
      name: 'adk-demo-target',
      description: 'ADK handoff demo — the agent control is handed to.',
      systemPrompt: 'You are adk-demo-target, the ADK demo persona handed to via transfer.',
      tools: ['adk_demo_noop'],
    });
  } catch (e) {
    log('defineAgent failed: ' + (e && e.message));
    // No personas → nothing else here can run meaningfully.
    return;
  }

  // ── delegate handoff (needs: tools + delegate) ──────────────────────────────
  // The delegate path injects a transfer_to_<target> tool backed by
  // __ccpAgentTool.invoke. Requires the tool registrar (expose_tool_dispatch) to
  // land the tool AND the agent-tool bridge (expose_agent_tool) to run the spawn.
  if (caps.tools && caps.delegate) {
    try {
      const h = defineHandoff({
        target: 'adk-demo-target',
        mode: 'delegate',
        description: 'Delegate the open question to the ADK demo target agent.',
      });
      const live = await h.ready;
      log('delegate handoff injected=' + live);
    } catch (e) {
      log('delegate handoff failed: ' + (e && e.message));
    }
  } else {
    const d = (caps.detail && (caps.detail.delegate || caps.detail.tools)) || {};
    log('delegate handoff skipped — needs tools+delegate; enable ' + (d.patch || 'expose_tool_dispatch / expose_agent_tool'));
  }

  // ── swap handoff (needs: tools + swap) ──────────────────────────────────────
  // The swap path overlays the target persona onto the live system prompt with
  // full system authority. allowSwapTargets pins the demo to ONE legal target, so
  // even if another persona were registered later, this handoff can never flip to
  // it. When __ccpSetSystemPrompt is absent the ADK degrades swap→delegate and
  // emits handoff.degraded; we still gate on caps.tools so the injected tool lands.
  if (caps.tools && caps.swap) {
    try {
      const h = defineHandoff({
        target: 'adk-demo-target',
        mode: 'swap',
        description: 'Swap the live persona to the ADK demo target (in-place baton pass).',
        allowSwapTargets: ['adk-demo-target'],
      });
      const live = await h.ready;
      log('swap handoff injected=' + live);
    } catch (e) {
      // A throw here is the SAFE outcome of the trust guards (e.g. an
      // allowSwapTargets / pin violation), not a boot failure. Log and continue.
      log('swap handoff refused/failed: ' + (e && e.message));
    }
  } else {
    const d = (caps.detail && (caps.detail.swap || caps.detail.tools)) || {};
    const why = d.reason ? ' (' + d.reason + ')' : '';
    log('swap handoff skipped' + why + ' — needs tools+swap; enable ' + (d.patch || 'expose_system_prompt'));
  }

  // ── AgentRouter (REGISTER ONLY — never auto-start) ──────────────────────────
  // The router is the lower-authority, trusted-code-only path: start() injects a
  // *user* message via __ccpSubmitInput to steer the session. Auto-driving the
  // session at boot would be a hostile default, so we ONLY register the personas
  // onto a router instance to prove the wiring is reachable. An operator calls
  // start() explicitly. We do not gate on caps.router because constructing +
  // register() touch no host primitive (start() is what needs __ccpSubmitInput).
  try {
    const router = new AgentRouter();
    router.register({
      name: 'adk-demo-source',
      systemPrompt: 'You are adk-demo-source.',
      // A no-op predicate: this demo never actually transitions. It exists to
      // prove the predicate seam is wired, not to steer a live session.
      handoff: () => null,
    });
    log('router registered (not started) — router cap live=' + !!caps.router);
  } catch (e) {
    log('router wiring failed: ' + (e && e.message));
  }

  // ── memory (no host primitive — pure fs under the project sandbox) ───────────
  // createMemory is keyed by FILE PATH and needs no __ccp* global. Exercise the
  // round-trip under a demo-local relative path (the store's sandbox rejects
  // absolute/traversing paths). This proves the persistence surface end-to-end.
  try {
    const mem = createMemory({ path: '.ccpatch/adk-demo-memory.json' });
    await mem.set('adk_demo_boot_count', (Number(mem.get('adk_demo_boot_count')) || 0) + 1);
    await mem.flush();
    log('memory round-trip ok — boot_count=' + mem.get('adk_demo_boot_count'));
  } catch (e) {
    log('memory round-trip failed: ' + (e && e.message));
  }
})().catch((e) => {
  try { process.stderr.write('[adk-handoff-demo] fatal: ' + (e && e.message) + '\\n'); } catch (_) {}
});
`;

export default {
  name: 'adk_handoff_demo',
  version: '0.1.0',
  category: 'optional',
  description:
    'End-to-end ADK reference consumer: exercises defineHandoff (delegate+swap), ' +
    'AgentRouter, and createMemory through a real patched session.',
  // Injects transfer_to_* tools via the ADK → expose_tool_dispatch (tools), and a
  // swap may overlay a persona → expose_system_prompt (prompt).
  capabilities: ['tools', 'prompt'],
  // Hard deps: the ADK reads these patches' exposed globals/contracts. The runner
  // enforces they are present and ordered before this patch. delegate needs the
  // agent-tool bridge; swap needs the system-prompt writer; both need the tool
  // registrar.
  dependsOn: ['expose_tool_dispatch', 'expose_agent_tool', 'expose_system_prompt'],
  enabled: false,
  // No bundle mutation: all behavior ships in the emitted ccpatch-agents/ file, not
  // in cli.js. apply() is intentionally a no-op, so we MUST NOT declare a
  // verify.present literal — that would make the runner treat the (correct)
  // no-change as anchor drift and force-fail the build (see adk_hello_agent's note
  // and runner/apply-pipeline.mjs). An absent-only verify describes a desired end
  // state the runner exempts from the no-change-is-fatal gate.
  verify: { absent: '__ccp_adk_handoff_demo_should_never_be_in_bundle__' },
  agentDir: {
    name: 'adk-handoff-demo',
    code: AGENT_CODE,
  },
  apply: (code) => code,
};

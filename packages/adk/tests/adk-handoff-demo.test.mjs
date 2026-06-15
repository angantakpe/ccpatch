/**
 * adk-handoff-demo.test.mjs
 *
 * Functional coverage for the end-to-end reference consumer shipped by
 * extensions/adk_handoff_demo.mjs. That patch emits an embedded agent body that,
 * at boot, drives the FULL ADK handoff surface — defineHandoff (delegate+swap),
 * AgentRouter, and createMemory — through the live __ccp* primitives.
 *
 * We can't boot a real patched CLI here, so we exercise the SAME contract the
 * emitted body implements against the REAL ADK modules (not a fake namespace —
 * this is the point: REVIEW.md §7 flagged that this machinery was validated only
 * by its own unit tests with no consumer). The consumer sequence under test is
 * replicated here as runDemoConsumer(), kept in lock-step with the AGENT_CODE
 * body in extensions/adk_handoff_demo.mjs. A drift guard below asserts the patch
 * body still drives the same four surfaces.
 *
 * Globals are stubbed the way adk-host.test.mjs does: a bare-global registrar +
 * persona writer + agent-tool bridge, all in-process, no patched CLI, no network.
 * Memory uses a real temp file UNDER the project root (the store's sandbox demands
 * the resolved path stay within cwd()).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

import { createAdk } from '../index.mjs';

// ── host-global isolation (mirrors adk-host.test.mjs) ────────────────────────
const POKED = [
  '__ccpRawTools', '__ccpAgentTool', '__ccpSetSystemPrompt', '__ccpGetSystemPrompt',
  '__ccpSystemPromptOverride', '__ccpSubmitInput', '__ccpBus', '__ccpRequire',
  '__ccpRegisterTool', '__ccpUnregisterTool', '__ccpGetDispatchNonce',
  '__ccpGetSystemPromptNonce', '__ccp_path', '__ccpDebug', '__ccpInspectContracts',
];
function isolateGlobals() {
  const saved = {};
  for (const k of POKED) saved[k] = globalThis[k];
  for (const k of POKED) delete globalThis[k];
  return () => {
    for (const k of POKED) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  };
}

/**
 * Install a fully-wired set of bare-global primitives so capabilities() reports
 * tools+swap+delegate+router+bus live, and the consumer can actually exercise
 * each path. Returns observability handles so a test can assert what happened.
 */
function installLiveHost() {
  const tools = [];
  globalThis.__ccpRawTools = tools;            // tools: live array sink
  const persona = { value: null };
  // swap: nonce-gated writer + reader + getNonce (matches expose_system_prompt v2)
  globalThis.__ccpSetSystemPrompt = (a, b) => {
    // two-arg nonce form OR legacy one-arg; the ADK acquires the nonce lazily.
    persona.value = (b === undefined) ? a : b;
  };
  globalThis.__ccpGetSystemPrompt = () => persona.value;
  globalThis.__ccpGetSystemPromptNonce = () => 'nonce';
  // delegate: agent-tool bridge — record invocations, return a canned result.
  const invokes = [];
  globalThis.__ccpAgentTool = {
    invoke: async (args) => { invokes.push(args); return 'delegated-result'; },
  };
  // router: input bar driver — record submits.
  const submits = [];
  globalThis.__ccpSubmitInput = (s) => { submits.push(s); };
  // bus: presence-probe satisfier with a recording emit.
  const events = [];
  globalThis.__ccpBus = { emit: (topic, payload) => { events.push([topic, payload]); } };
  return { tools, persona, invokes, submits, events };
}

// ── the consumer sequence under test (lock-step with AGENT_CODE) ─────────────
// This is the same four-surface drive the emitted body performs, against a real
// createAdk() scope. `trace` is seeded by the caller with { steps, errors, memPath }
// so the test can choose the sandbox path. Returns the trace, filled in.
async function runDemoConsumerSeeded(adk, trace) {
  const caps = adk.capabilities();

  // personas (always safe; target must exist BEFORE the swap pins its sha256)
  adk.defineAgent({
    name: 'adk-demo-source', description: 'src',
    systemPrompt: 'You are adk-demo-source, the originating ADK demo persona.',
    tools: ['adk_demo_noop'],
  });
  adk.defineAgent({
    name: 'adk-demo-target', description: 'tgt',
    systemPrompt: 'You are adk-demo-target, the ADK demo persona handed to via transfer.',
    tools: ['adk_demo_noop'],
  });
  trace.steps.push('personas');

  // delegate handoff
  if (caps.tools && caps.delegate) {
    try {
      const h = adk.defineHandoff({
        target: 'adk-demo-target', mode: 'delegate',
        description: 'Delegate the open question to the ADK demo target agent.',
      });
      trace.delegateReady = await h.ready;
      trace.steps.push('delegate');
    } catch (e) { trace.errors.push(['delegate', e.message]); }
  }

  // swap handoff (allowlisted to the one demo target)
  if (caps.tools && caps.swap) {
    try {
      const h = adk.defineHandoff({
        target: 'adk-demo-target', mode: 'swap',
        description: 'Swap the live persona to the ADK demo target.',
        allowSwapTargets: ['adk-demo-target'],
      });
      trace.swapReady = await h.ready;
      trace.steps.push('swap');
    } catch (e) { trace.errors.push(['swap', e.message]); }
  }

  // AgentRouter — REGISTER ONLY (never start: that would steer the live session)
  try {
    const router = new adk.AgentRouter();
    router.register({ name: 'adk-demo-source', systemPrompt: 'You are adk-demo-source.', handoff: () => null });
    trace.routerActive = router.active;     // null until started — proves no auto-drive
    trace.steps.push('router');
  } catch (e) { trace.errors.push(['router', e.message]); }

  // memory round-trip under a demo-local sandbox path
  try {
    const mem = adk.createMemory({ path: trace.memPath });
    await mem.set('adk_demo_boot_count', (Number(mem.get('adk_demo_boot_count')) || 0) + 1);
    await mem.flush();
    trace.bootCount = mem.get('adk_demo_boot_count');
    trace.steps.push('memory');
  } catch (e) { trace.errors.push(['memory', e.message]); }

  return trace;
}

// memory needs a real path UNDER cwd() (the sandbox rejects absolute/traversing).
const SCRATCH = join(cwd(), '.tmp-adk-handoff-demo-tests');
test.before(() => { mkdirSync(SCRATCH, { recursive: true }); });
test.after(() => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ } });
const memRel = '.tmp-adk-handoff-demo-tests/mem.json';

test('end-to-end: every surface is exercised without error under a live host', async () => {
  const restore = isolateGlobals();
  const host = installLiveHost();
  const adk = createAdk();
  try {
    const trace = { steps: [], errors: [], memPath: memRel };
    // inline-drive so we can seed memPath; mirrors runDemoConsumer exactly.
    const out = await runDemoConsumerSeeded(adk, trace);

    assert.deepEqual(out.errors, [], 'no surface threw: ' + JSON.stringify(out.errors));
    assert.ok(out.steps.includes('personas'), 'personas defined');
    assert.ok(out.steps.includes('delegate'), 'delegate handoff exercised');
    assert.ok(out.steps.includes('swap'), 'swap handoff exercised');
    assert.ok(out.steps.includes('router'), 'router registered');
    assert.ok(out.steps.includes('memory'), 'memory round-trip ran');

    // delegate + swap each injected a transfer_to_* tool into the live array.
    const toolNames = host.tools.map((t) => t && t.name).filter(Boolean);
    assert.ok(toolNames.includes('transfer_to_adk-demo-target'),
      'a transfer_to_adk-demo-target tool landed in __ccpRawTools: ' + JSON.stringify(toolNames));

    // router was registered but NEVER started — the live session was not steered.
    assert.equal(out.routerActive, null, 'router did not auto-start (no session steer)');
    assert.equal(host.submits.length, 0, '__ccpSubmitInput was never called at boot');

    // memory persisted and round-tripped.
    assert.equal(out.bootCount, 1, 'first boot increments the counter to 1');
    assert.ok(existsSync(join(cwd(), memRel)), 'memory file was written under the sandbox');
  } finally {
    adk.dispose?.();
    restore();
  }
});

test('memory persists across consumer runs (cross-boot increment)', async () => {
  const restore = isolateGlobals();
  installLiveHost();
  // Distinct path from the end-to-end test: createMemory is keyed by FILE PATH
  // (process-global by design), so sharing memRel would carry that test's count
  // in. Start from a clean, dedicated file so the increment is unambiguous.
  const xbootRel = '.tmp-adk-handoff-demo-tests/xboot.json';
  try { rmSync(join(cwd(), xbootRel), { force: true }); } catch { /* ignore */ }
  try {
    const a = createAdk();
    const t1 = await runDemoConsumerSeeded(a, { steps: [], errors: [], memPath: xbootRel });
    a.dispose?.();
    const b = createAdk();
    const t2 = await runDemoConsumerSeeded(b, { steps: [], errors: [], memPath: xbootRel });
    b.dispose?.();
    assert.equal(t1.bootCount, 1, 'first run = 1');
    assert.equal(t2.bootCount, 2, 'second run reads the persisted value and increments to 2');
  } finally {
    restore();
  }
});

test('degraded host (no tools/swap/delegate): consumer skips cleanly, never throws', async () => {
  const restore = isolateGlobals();
  // No globals installed at all → capabilities() reports everything false.
  try {
    const adk = createAdk();
    const caps = adk.capabilities();
    assert.equal(caps.tools, false);
    assert.equal(caps.swap, false);
    const out = await runDemoConsumerSeeded(adk, { steps: [], errors: [], memPath: memRel });
    adk.dispose?.();
    // The handoff steps are gated off; personas + router + memory still run.
    assert.deepEqual(out.errors, [], 'no step threw under a bare host');
    assert.ok(out.steps.includes('personas'));
    assert.ok(!out.steps.includes('delegate'), 'delegate gated off without tools+delegate');
    assert.ok(!out.steps.includes('swap'), 'swap gated off without tools+swap');
    assert.ok(out.steps.includes('router'), 'router registration is host-independent');
    assert.ok(out.steps.includes('memory'), 'memory is host-independent');
  } finally {
    restore();
  }
});

test('drift guard: the patch body still drives all four ADK surfaces', () => {
  const src = readFileSync(new URL('../../../extensions/adk_handoff_demo.mjs', import.meta.url), 'utf8');
  assert.match(src, /defineHandoff\(\{[\s\S]*?mode:\s*'delegate'/, 'delegate handoff still driven');
  assert.match(src, /defineHandoff\(\{[\s\S]*?mode:\s*'swap'/, 'swap handoff still driven');
  assert.match(src, /allowSwapTargets:\s*\['adk-demo-target'\]/, 'swap still allowlist-constrained');
  assert.match(src, /new AgentRouter\(\)/, 'AgentRouter still constructed');
  assert.match(src, /createMemory\(\{\s*path:/, 'createMemory still exercised');
  // Safety invariant: the demo must NOT auto-start the router at boot.
  assert.doesNotMatch(src, /router\.start\(/, 'demo must never auto-start the router (session-steer guard)');
});

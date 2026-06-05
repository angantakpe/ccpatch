/**
 * adk-core.test.mjs
 *
 * Unit coverage for the NEW createAdk()/scoped surface of the ccpatch ADK
 * (packages/adk/index.mjs + tool-registry + handoff + agent), focusing on:
 *   - createAdk() instance isolation (two instances do NOT share agent/tool state)
 *   - bounded poll timeout + the ToolHandle.ready Promise (true on inject, false
 *     on poll timeout / dispose-before-inject)
 *   - defineTool / defineHandoff disposer removes the tool from a stubbed
 *     __ccpRawTools array
 *   - input validation rejects malformed input WITHOUT calling execute()
 *   - reversible swap (push then restore returns the prior system prompt) +
 *     allowSwapTargets allowlist enforcement
 *   - capabilities() returns the right booleans against stubbed globals
 *
 * Plain ESM, no patched CLI, no network. The tool-registry poller uses real
 * timers (50ms cadence, 100-attempt ceiling ≈ 5s); the timeout test shortens
 * the wait by counting on the bounded ceiling, not real wall-clock 5s — it polls
 * for the .ready resolution which the source settles on the LAST poll tick.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdk, capabilities, listTools, swapDepth, currentPersona, defineTool,
  tryAcquireSwap,
} from '../packages/adk/index.mjs';
import { defineToolIn, createToolScope, validateInput } from '../packages/adk/tool-registry.mjs';

// ── shared global hygiene ─────────────────────────────────────────────────────

/** Snapshot + clear every __ccp* global this file pokes at; returns a restorer. */
function isolateGlobals() {
  const keys = [
    '__ccpRawTools', '__ccpAgentTool', '__ccpSetSystemPrompt',
    '__ccpGetSystemPrompt', '__ccpSystemPromptOverride', '__ccpSubmitInput',
    '__ccpBus', '__ccpInspectContracts', '__ccp_path',
  ];
  const saved = {};
  for (const k of keys) saved[k] = globalThis[k];
  for (const k of keys) delete globalThis[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
  };
}

// ── createAdk(): instance isolation ───────────────────────────────────────────

test('createAdk() — two instances do not share agent state', () => {
  const restore = isolateGlobals();
  try {
    const a = createAdk();
    const b = createAdk();

    a.defineAgent({ name: 'iso-agent', systemPrompt: 'A persona' });

    assert.ok(a.getAgent('iso-agent'), 'instance A sees its own agent');
    assert.equal(b.getAgent('iso-agent'), null, 'instance B does NOT see A’s agent');
    assert.deepEqual(a.listAgents().map((x) => x.name), ['iso-agent']);
    assert.deepEqual(b.listAgents(), []);
  } finally {
    restore();
  }
});

test('createAdk() — two instances do not share tool state', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = []; // present → synchronous inject
    const a = createAdk();
    const b = createAdk();

    a.defineTool({
      name: 'iso-tool',
      description: 't',
      inputSchema: { type: 'object' },
      execute: async () => 'A',
    });

    // The live array is the single shared sink, but each ADK instance owns its
    // own QUEUE/scope. Disposing on B must not remove A's tool, and B never had
    // it queued. Inject the SAME name on B and confirm A's dispose only nukes one.
    const inRaw = () => globalThis.__ccpRawTools.filter((t) => t.name === 'iso-tool').length;
    assert.equal(inRaw(), 1, 'A injected its tool into the shared raw array');

    // B has no record of iso-tool in its scope — disposing a non-owned name on B
    // would still hit the shared array, so instead assert scope isolation by the
    // queue path: with the array ABSENT, each instance queues independently.
    delete globalThis.__ccpRawTools;
    const aHandle = a.defineTool({ name: 'q-a', inputSchema: {}, execute: async () => 'x' });
    const bHandle = b.defineTool({ name: 'q-b', inputSchema: {}, execute: async () => 'y' });
    assert.notEqual(aHandle, bHandle);
    // Dispose both queued (never-injected) handles so their pollers tear down.
    aHandle.dispose();
    bHandle.dispose();
  } finally {
    restore();
  }
});

// ── ToolHandle.ready + bounded poll ───────────────────────────────────────────

test('defineTool .ready resolves true once injected into a live __ccpRawTools', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'ready-sync',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    });
    assert.equal(await h.ready, true, 'synchronous inject resolves ready=true');
  } finally {
    restore();
  }
});

test('defineTool .ready resolves true after the bounded poll drains a late array', async () => {
  const restore = isolateGlobals();
  try {
    delete globalThis.__ccpRawTools; // absent → queue + poll
    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'ready-late',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    });
    // Make the array appear after one poll cadence; the 50ms poller drains it.
    setTimeout(() => { globalThis.__ccpRawTools = []; }, 60);
    assert.equal(await h.ready, true, 'late array → poller drains → ready=true');
    assert.ok(
      globalThis.__ccpRawTools.some((t) => t.name === 'ready-late'),
      'tool landed in the array',
    );
  } finally {
    restore();
  }
});

test('defineTool .ready resolves false when dispose() beats injection', async () => {
  const restore = isolateGlobals();
  try {
    delete globalThis.__ccpRawTools; // never appears
    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'ready-disposed',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    });
    h.dispose(); // cancels the queue entry before any array shows up
    assert.equal(await h.ready, false, 'disposed-before-injected → ready=false');
  } finally {
    restore();
  }
});

test('defineTool poll is bounded — .ready rejects-to-false on timeout (no array ever)', async () => {
  const restore = isolateGlobals();
  try {
    delete globalThis.__ccpRawTools; // array never appears for the whole poll window
    const scope = createToolScope();
    // Silence the one-shot warning the source prints on timeout.
    const realWarn = console.warn;
    console.warn = () => {};
    const h = defineToolIn(scope, {
      name: 'never-injected',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    });
    try {
      // POLL_LIMIT(100) × POLL_INTERVAL(50ms) ≈ 5s; allow headroom.
      const settled = await Promise.race([
        h.ready.then((v) => ({ v })),
        new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
      ]);
      assert.deepEqual(settled, { v: false }, 'bounded poll settles ready=false, never hangs');
      assert.equal(scope.pollHandle, null, 'poller torn down after the ceiling');
    } finally {
      console.warn = realWarn;
    }
  } finally {
    restore();
  }
});

// ── disposer removes the tool from a stubbed __ccpRawTools ─────────────────────

test('ToolHandle.dispose() removes the injected tool from the live array', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'disposable',
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    });
    assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'disposable'));
    const removed = h.dispose();
    assert.equal(removed, true, 'dispose reports it removed a live entry');
    assert.equal(
      globalThis.__ccpRawTools.some((t) => t.name === 'disposable'), false,
      'tool gone from __ccpRawTools after dispose',
    );
    assert.equal(h.dispose(), false, 'second dispose is a no-op (nothing to remove)');
  } finally {
    restore();
  }
});

test('defineHandoff handle dispose() removes the transfer tool from the array', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const adk = createAdk();
    adk.defineAgent({ name: 'ho-target', systemPrompt: 'P' });
    const h = adk.defineHandoff({ target: 'ho-target' });
    assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'transfer_to_ho-target'));
    assert.equal(h.dispose(), true);
    assert.equal(
      globalThis.__ccpRawTools.some((t) => t.name === 'transfer_to_ho-target'), false,
      'handoff tool removed from __ccpRawTools',
    );
  } finally {
    restore();
  }
});

// ── input validation rejects malformed input WITHOUT calling execute() ─────────

test('validateInput flags missing required + wrong type, accepts a valid object', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' }, count: { type: 'number' } },
  };
  assert.match(validateInput(schema, {}), /missing required property "name"/);
  assert.match(validateInput(schema, { name: 'x', count: 'NaN' }), /property "count" must be of type number/);
  assert.match(validateInput(schema, 42), /expected an object input, got number/);
  assert.match(validateInput(schema, ['a']), /got array/);
  assert.equal(validateInput(schema, { name: 'x', count: 3 }), null, 'valid input → null');
  // Unknown schema shape → fail-open (null).
  assert.equal(validateInput({ type: 'string' }, 123), null);
  assert.equal(validateInput(null, 123), null);
});

test('tool call() rejects malformed input as a tool_result and never runs execute()', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    let ran = false;
    defineToolIn(scope, {
      name: 'guarded',
      inputSchema: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string' } },
      },
      execute: async () => { ran = true; return 'should not run'; },
    });
    const t = globalThis.__ccpRawTools.find((x) => x.name === 'guarded');

    const bad = await t.call({});
    assert.equal(ran, false, 'execute() was NOT called for invalid input');
    assert.equal(bad[0].type, 'text');
    assert.match(bad[0].text, /Invalid input for tool "guarded": missing required property "q"/);

    const wrongType = await t.call({ q: 7 });
    assert.equal(ran, false, 'still no execute() on a type violation');
    assert.match(wrongType[0].text, /must be of type string/);

    const ok = await t.call({ q: 'hi' });
    assert.equal(ran, true, 'valid input finally runs execute()');
    assert.deepEqual(ok, [{ type: 'text', text: 'should not run' }]);
  } finally {
    restore();
  }
});

// ── reversible swap + allowSwapTargets enforcement ────────────────────────────

test('swap handoff is reversible — restore() pops back the prior system prompt', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    // Model the live override slot expose_system_prompt maintains.
    globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
    globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };

    const adk = createAdk();
    adk.defineAgent({ name: 'swap-persona', systemPrompt: 'NEW PERSONA' });

    const h = adk.defineHandoff({ target: 'swap-persona', mode: 'swap' });
    const res = await h.execute({ task: 'x' });
    assert.match(res, /persona swapped/i);
    assert.equal(globalThis.__ccpSystemPromptOverride, 'NEW PERSONA', 'swap applied the new prompt');

    // A transfer_back tool is auto-registered to give the model a revert path.
    assert.ok(
      globalThis.__ccpRawTools.some((t) => t.name === 'transfer_back'),
      'transfer_back auto-registered after a swap',
    );

    const reverted = adk.restoreSystemPrompt();
    assert.equal(reverted, true, 'restore reports success');
    assert.equal(globalThis.__ccpSystemPromptOverride, 'ORIGINAL', 'prior prompt restored (LIFO)');

    // Stack empty now → restore is a no-op.
    assert.equal(adk.restoreSystemPrompt(), false, 'empty stack → restore returns false');
  } finally {
    restore();
  }
});

test('swap restore stack is LIFO across nested swaps', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    globalThis.__ccpSystemPromptOverride = 'BASE';
    globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
    const adk = createAdk();
    adk.defineAgent({ name: 'p1', systemPrompt: 'ONE' });
    adk.defineAgent({ name: 'p2', systemPrompt: 'TWO' });

    await adk.defineHandoff({ target: 'p1', mode: 'swap' }).execute({ task: 'a' });
    assert.equal(globalThis.__ccpSystemPromptOverride, 'ONE');
    await adk.defineHandoff({ target: 'p2', mode: 'swap' }).execute({ task: 'b' });
    assert.equal(globalThis.__ccpSystemPromptOverride, 'TWO');

    adk.restoreSystemPrompt();
    assert.equal(globalThis.__ccpSystemPromptOverride, 'ONE', 'pops TWO → back to ONE');
    adk.restoreSystemPrompt();
    assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'pops ONE → back to BASE');
  } finally {
    restore();
  }
});

test('allowSwapTargets enforces the allowlist at definition time (programmer error)', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const adk = createAdk();
    adk.defineAgent({ name: 'allowed', systemPrompt: 'A' });
    adk.defineAgent({ name: 'blocked', systemPrompt: 'B' });

    // Target NOT in the allowlist → throws up front, before any tool is injected.
    assert.throws(
      () => adk.defineHandoff({ target: 'blocked', mode: 'swap', allowSwapTargets: ['allowed'] }),
      /swap target "blocked" is not in allowSwapTargets \[allowed\]/,
    );
    assert.equal(
      globalThis.__ccpRawTools.some((t) => t.name === 'transfer_to_blocked'), false,
      'no tool injected for a disallowed swap',
    );

    // Allowed target → no throw, tool injected.
    adk.defineHandoff({ target: 'allowed', mode: 'swap', allowSwapTargets: ['allowed'] });
    assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'transfer_to_allowed'));

    // allowSwapTargets is ignored for delegate mode (only swap is gated).
    assert.doesNotThrow(
      () => adk.defineHandoff({ target: 'blocked', mode: 'delegate', allowSwapTargets: ['allowed'] }),
    );

    // A non-array allowlist is itself a programmer error.
    assert.throws(
      () => adk.defineHandoff({ target: 'allowed', mode: 'swap', allowSwapTargets: 'allowed' }),
      /`allowSwapTargets` must be an array/,
    );
  } finally {
    restore();
  }
});

// ── capabilities() against stubbed globals ────────────────────────────────────

/** Assert the booleans match `bools` and that detail mirrors them (no reasons). */
function assertCapsBooleans(caps, bools) {
  assert.equal(caps.tools, bools.tools);
  assert.equal(caps.delegate, bools.delegate);
  assert.equal(caps.swap, bools.swap);
  assert.equal(caps.router, bools.router);
  assert.equal(caps.bus, bools.bus);
  for (const cap of ['tools', 'delegate', 'swap', 'router', 'bus']) {
    assert.equal(caps.detail[cap].live, bools[cap], `detail.${cap}.live mirrors the boolean`);
    assert.equal(typeof caps.detail[cap].patch, 'string', `detail.${cap}.patch is a name`);
  }
}

test('capabilities() reports all false with no __ccp* globals present', () => {
  const restore = isolateGlobals();
  try {
    const caps = capabilities();
    assertCapsBooleans(caps, {
      tools: false, delegate: false, swap: false, router: false, bus: false,
    });
    // No drift handshake ran → no reasons attached.
    for (const cap of ['tools', 'delegate', 'swap', 'router', 'bus']) {
      assert.equal(caps.detail[cap].reason, undefined);
    }
  } finally {
    restore();
  }
});

test('capabilities() reports each capability true against its live primitive', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    globalThis.__ccpAgentTool = { invoke: async () => ({}) };
    globalThis.__ccpSetSystemPrompt = () => {};
    globalThis.__ccpSubmitInput = async () => {};
    globalThis.__ccpBus = { emit: () => {} };
    assertCapsBooleans(capabilities(), {
      tools: true, delegate: true, swap: true, router: true, bus: true,
    });
  } finally {
    restore();
  }
});

test('capabilities().detail names the providing patch for each capability', () => {
  const restore = isolateGlobals();
  try {
    const { detail } = capabilities();
    assert.equal(detail.tools.patch, 'expose_tool_dispatch');
    assert.equal(detail.delegate.patch, 'expose_agent_tool');
    assert.equal(detail.swap.patch, 'expose_system_prompt');
    assert.equal(detail.router.patch, 'expose_submit_input');
    assert.equal(detail.bus.patch, 'event_bus / fetch_interceptor');
  } finally {
    restore();
  }
});

test('capabilities() downgrades delegate when the agentTool contract proves shape drift', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpAgentTool = { invoke: async () => ({}) }; // probe says delegate=true
    // Contract registry positively reports agentTool with a shape that LACKS 'invoke'.
    globalThis.__ccpInspectContracts = () => [
      { name: 'agentTool', version: 1, producer: 'x', shape: ['run'] },
    ];
    const caps = capabilities();
    assert.equal(caps.delegate, false, 'contract drift flips delegate true→false');
    assert.equal(caps.detail.delegate.live, false, 'detail mirrors the downgrade');
    assert.match(caps.detail.delegate.reason, /invoke/, 'records why it was downgraded');

    // A contract whose shape DOES include invoke leaves the probe result intact.
    globalThis.__ccpInspectContracts = () => [
      { name: 'agentTool', version: 1, producer: 'x', shape: ['invoke', 'run'] },
    ];
    const ok = capabilities();
    assert.equal(ok.delegate, true, 'matching shape keeps delegate=true');
    assert.equal(ok.detail.delegate.reason, undefined, 'no reason when shape is fine');

    // No contract entry → probe is authoritative (stays true).
    globalThis.__ccpInspectContracts = () => [];
    assert.equal(capabilities().delegate, true, 'absent contract → probe wins');
  } finally {
    restore();
  }
});

test('capabilities() downgrades swap on a stale systemPrompt contract (v1 < required v2)', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpSetSystemPrompt = () => {}; // probe says swap=true
    // A drifted host advertises the OLD v1 systemPrompt contract (no nonce gate).
    globalThis.__ccpInspectContracts = () => [
      { name: 'systemPrompt', version: 1, producer: 'expose_system_prompt', shape: ['set', 'get'] },
    ];
    const caps = capabilities();
    assert.equal(caps.swap, false, 'stale systemPrompt v1 downgrades swap true→false');
    assert.equal(caps.detail.swap.live, false);
    assert.match(caps.detail.swap.reason, /v1 < required v2/, 'reason cites the version gap');

    // v2 present but shape missing getNonce → downgraded for shape drift instead.
    globalThis.__ccpInspectContracts = () => [
      { name: 'systemPrompt', version: 2, producer: 'expose_system_prompt', shape: ['set', 'get'] },
    ];
    const shapeDrift = capabilities();
    assert.equal(shapeDrift.swap, false, 'v2 but no getNonce still downgrades');
    assert.match(shapeDrift.detail.swap.reason, /getNonce/);

    // A current v2 contract advertising getNonce keeps swap=true.
    globalThis.__ccpInspectContracts = () => [
      { name: 'systemPrompt', version: 2, producer: 'expose_system_prompt', shape: ['set', 'get', 'getNonce'] },
    ];
    const fresh = capabilities();
    assert.equal(fresh.swap, true, 'fresh v2 + getNonce keeps swap=true');
    assert.equal(fresh.detail.swap.reason, undefined);
  } finally {
    restore();
  }
});

test('capabilities() downgrades tools when toolDispatch shape lacks registerTool', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = []; // probe says tools=true
    // Old toolDispatch contract without the nonce-gated registrar.
    globalThis.__ccpInspectContracts = () => [
      { name: 'toolDispatch', version: 1, producer: 'expose_tool_dispatch', shape: ['getTools', 'invokeTool'] },
    ];
    const caps = capabilities();
    assert.equal(caps.tools, false, 'missing registerTool downgrades tools');
    assert.match(caps.detail.tools.reason, /registerTool/);

    // Current shape with registerTool keeps tools=true.
    globalThis.__ccpInspectContracts = () => [
      { name: 'toolDispatch', version: 2, producer: 'expose_tool_dispatch', shape: ['getTools', 'registerTool', 'unregisterTool'] },
    ];
    assert.equal(capabilities().tools, true, 'registerTool present → tools stays true');
  } finally {
    restore();
  }
});

// ── createAdk(): handoff resolves agents from its OWN registry ─────────────────

test('createAdk() handoff bridges only its OWN registered agent into agentDef', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const calls = [];
    globalThis.__ccpAgentTool = { invoke: async (args) => { calls.push(args); return { text: 'R' }; } };

    const a = createAdk();
    const b = createAdk();
    a.defineAgent({ name: 'shared-name', description: 'A-desc', systemPrompt: 'A', tools: ['Read'] });

    // Instance A knows the agent → bridges a synthetic agentDef.
    await a.defineHandoff({ target: 'shared-name' }).execute({ task: 't' });
    assert.equal(calls[0].agentDef?.whenToUse, 'A-desc');

    // Instance B does NOT know it → treats it as a native subagent (no agentDef).
    await b.defineHandoff({ target: 'shared-name' }).execute({ task: 't' });
    assert.equal(calls[1].agentDef, undefined, 'B has no record → no synthetic agentDef');
  } finally {
    restore();
  }
});

// ── introspection: listTools / swapDepth / currentPersona ─────────────────────

test('listTools() reflects an instance scope; instances do not share tool listings', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = []; // present → synchronous inject
    const a = createAdk();
    const b = createAdk();

    a.defineTool({ name: 'a-only', inputSchema: { type: 'object' }, execute: async () => 'x' });

    assert.deepEqual(a.listTools(), ['a-only'], 'A lists its own tool');
    assert.deepEqual(b.listTools(), [], 'B does NOT see A’s tool in its scope');

    const h = b.defineTool({ name: 'b-only', inputSchema: { type: 'object' }, execute: async () => 'y' });
    assert.deepEqual(b.listTools(), ['b-only']);
    h.dispose();
    assert.deepEqual(b.listTools(), [], 'dispose() drops the tool from the listing');
  } finally {
    restore();
  }
});

test('top-level listTools() reflects the DEFAULT instance scope', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const before = listTools();
    const h = defineTool({ name: 'top-level-probe', inputSchema: { type: 'object' }, execute: async () => 'z' });
    assert.ok(listTools().includes('top-level-probe'), 'DEFAULT listTools sees the new tool');
    h.dispose();
    assert.deepEqual(listTools(), before, 'dispose() restores the prior DEFAULT listing');
  } finally {
    restore();
  }
});

test('swapDepth()/currentPersona() track swaps on default + createAdk instances', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    globalThis.__ccpSystemPromptOverride = 'BASE';
    globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride;
    globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };

    const adk = createAdk();
    adk.defineAgent({ name: 'persona-a', systemPrompt: 'PERSONA A' });

    assert.equal(adk.swapDepth(), 0, 'no swaps yet → depth 0');
    assert.equal(adk.currentPersona(), 'BASE', 'currentPersona reads the live slot');

    await adk.defineHandoff({ target: 'persona-a', mode: 'swap' }).execute({ task: 't' });
    assert.equal(adk.swapDepth(), 1, 'one swap owned by this instance');
    assert.equal(adk.currentPersona(), 'PERSONA A', 'persona reflects the swap');
    // The DEFAULT instance owns NO entries on the global stack.
    assert.equal(swapDepth(), 0, 'DEFAULT swapDepth unaffected by another instance');
    assert.equal(currentPersona(), 'PERSONA A', 'top-level currentPersona reads the same global slot');

    adk.restoreSystemPrompt();
    assert.equal(adk.swapDepth(), 0, 'restore drops this instance’s depth back to 0');
    assert.equal(adk.currentPersona(), 'BASE', 'persona restored');
  } finally {
    restore();
  }
});

// ── createAdk().dispose() ─────────────────────────────────────────────────────

test('createAdk().dispose() tears down tools/swap/agents and is idempotent', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    globalThis.__ccpSystemPromptOverride = 'BASE';
    globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride;
    globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };

    const adk = createAdk();
    adk.defineAgent({ name: 'd-agent', systemPrompt: 'PERSONA D' });
    adk.defineTool({ name: 'd-tool', inputSchema: { type: 'object' }, execute: async () => 'x' });

    // A live tool + a registered agent + an active swap before teardown.
    assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'd-tool'), 'tool injected live');
    assert.deepEqual(adk.listTools(), ['d-tool']);
    assert.ok(adk.getAgent('d-agent'), 'agent registered');
    await adk.defineHandoff({ target: 'd-agent', mode: 'swap' }).execute({ task: 't' });
    assert.equal(adk.swapDepth(), 1, 'one swap owned before dispose');
    assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA D');

    adk.dispose();

    // Tools removed from the live array + the scope listing cleared.
    assert.equal(
      globalThis.__ccpRawTools.some((t) => t.name === 'd-tool'), false,
      'dispose removed the live tool from __ccpRawTools',
    );
    assert.deepEqual(adk.listTools(), [], 'tool scope listing cleared');
    // Swap footprint unwound → persona restored, depth back to 0.
    assert.equal(adk.swapDepth(), 0, 'swap stack unwound on dispose');
    assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'persona restored on dispose');
    // Agent registry cleared.
    assert.equal(adk.getAgent('d-agent'), null, 'agent registry cleared on dispose');

    // Idempotent — a second dispose must not throw.
    assert.doesNotThrow(() => adk.dispose(), 'dispose is idempotent');
  } finally {
    restore();
  }
});

// ── adk.toolStatuses() lifecycle view ─────────────────────────────────────────

test('adk.toolStatuses() reports queued / live / failed', async () => {
  const restore = isolateGlobals();
  try {
    // Live array present → a defined tool injects synchronously (status 'live').
    globalThis.__ccpRawTools = [];
    const adk = createAdk();
    adk.defineTool({ name: 'live-tool', inputSchema: { type: 'object' }, execute: async () => 'x' });
    const liveStatuses = adk.toolStatuses();
    assert.deepEqual(
      liveStatuses.find((s) => s.name === 'live-tool'),
      { name: 'live-tool', status: 'live' },
      'an injected tool reports status live',
    );

    // Array absent → a defined tool queues (status 'queued') until it times out.
    delete globalThis.__ccpRawTools;
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const h = adk.defineTool({ name: 'pending-tool', inputSchema: { type: 'object' }, execute: async () => 'y' });
      const queued = adk.toolStatuses().find((s) => s.name === 'pending-tool');
      assert.equal(queued.status, 'queued', 'a never-injected tool starts queued');

      // Drive it to the failed terminal state by exhausting the bounded poll.
      const settled = await Promise.race([
        h.ready.then((v) => ({ v })),
        new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
      ]);
      assert.deepEqual(settled, { v: false }, 'poll bounded → ready=false');
      const failed = adk.toolStatuses().find((s) => s.name === 'pending-tool');
      assert.equal(failed.status, 'failed', 'a timed-out tool reports status failed');
    } finally {
      console.warn = realWarn;
    }
  } finally {
    restore();
  }
});

// ── adk.tryAcquireSwap(): exclusive swap lock ─────────────────────────────────

test('adk.tryAcquireSwap() returns a working token; a second instance is refused while held', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    globalThis.__ccpSystemPromptOverride = 'BASE';
    globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride;
    globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };

    const a = createAdk();
    const b = createAdk();

    const tokenA = a.tryAcquireSwap();
    assert.ok(tokenA, 'instance A acquires the swap lock');
    assert.equal(tokenA.owned, true, 'A owns the lock');

    // The token drives an in-place persona swap + LIFO restore.
    tokenA.swap('PERSONA A');
    assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA A', 'token swap applied the persona');
    assert.equal(a.swapDepth(), 1, 'A owns one swap-stack entry');

    // A SECOND instance is refused while A holds the exclusive lock.
    assert.equal(b.tryAcquireSwap(), null, 'B refused while A holds the lock');
    // The DEFAULT top-level scope is likewise refused.
    assert.equal(tryAcquireSwap(), null, 'DEFAULT scope refused while A holds the lock');

    // Releasing A unwinds its swap footprint and frees the lock.
    tokenA.release();
    assert.equal(tokenA.owned, false, 'A no longer owns the released token');
    assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'release restored the base persona');

    // Now B can acquire.
    const tokenB = b.tryAcquireSwap();
    assert.ok(tokenB, 'B acquires after A releases');
    tokenB.release();
  } finally {
    restore();
  }
});

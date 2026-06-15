/**
 * adk-handoff.test.mjs
 *
 * Unit coverage for the ccpatch ADK handoff protocol (packages/adk):
 *   - agent registry (defineAgent / getAgent / listAgents)
 *   - live tool injection + queue/drain (tool-registry.mjs)
 *   - defineHandoff delegate mode (native target vs ADK agentDef merge)
 *   - defineHandoff swap mode (success + graceful degradation to delegate)
 *   - bus events (handoff.start / handoff.end / handoff.degraded)
 *   - expose_system_prompt overlay scoping by querySource (__ccp_path)
 *
 * No patched CLI and no network. The handoff/agent/tool-registry modules are
 * plain ESM and run directly; the expose_system_prompt boot IIFE is eval'd in a
 * vm sandbox the same way tests/patch-verification.test.mjs does (Layer 3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { defineAgent, getAgent, listAgents } from '../agent.mjs';
import { createAgentScope, defineAgentIn, getAgentIn } from '../agent.mjs';
import { defineTool } from '../tool-registry.mjs';
import {
  defineHandoff,
  AgentRouter,
  createDefineHandoff,
  createHandoffScope,
  restoreSystemPromptIn,
  swapDepthIn,
  currentPersona,
  tryAcquireSwap,
  disposeHandoffScope,
  __resetSystemPromptDriftGuardForTests,
} from '../handoff.mjs';
// Cross-boundary: integration-checks the live ccpatch shim the ADK consumes at
// runtime. The ADK package does not vendor it; this path reaches back into the
// monorepo's extensions/ (repo-root, three levels up from this test file).
import expose from '../../../extensions/expose_system_prompt.mjs';

// ── Shared test harness ───────────────────────────────────────────────────────

/** Install a capturing __ccpBus; returns the recorded {topic,payload} list. */
function captureBus() {
  const events = [];
  globalThis.__ccpBus = { emit: (topic, payload) => events.push({ topic, payload }) };
  return events;
}
const topics = (events) => events.map((e) => e.topic);
const payloadOf = (events, topic) => events.find((e) => e.topic === topic)?.payload;

/** Stub __ccpAgentTool.invoke; returns a recorder for the last invoke args. */
function stubAgentTool(returnValue = { text: 'SUBAGENT RESULT' }) {
  const rec = { calls: [] };
  globalThis.__ccpAgentTool = {
    invoke: async (args) => {
      rec.calls.push(args);
      rec.last = args;
      return returnValue;
    },
  };
  return rec;
}

function resetGlobals() {
  globalThis.__ccpRawTools = [];
  delete globalThis.__ccp_path;
  delete globalThis.__ccpAgentTool;
  delete globalThis.__ccpSetSystemPrompt;
  delete globalThis.__ccpGetSystemPrompt;
  delete globalThis.__ccpGetSystemPromptNonce;
  delete globalThis.__ccpSystemPromptOverride;
  delete globalThis.__ccpBus;
  delete globalThis.__ccpRequire;
  delete globalThis.__ccpInspectContracts;
  delete globalThis.__ccpSubmitInput;
}

// ── tool-registry: queue then drain (MUST run before any present-array inject) ─

test('tool-registry queues a tool until __ccpRawTools appears, then drains', async () => {
  delete globalThis.__ccpRawTools; // array absent → defineTool must queue
  const def = defineTool({
    name: 'queued_tool',
    description: 'q',
    inputSchema: { type: 'object' },
    execute: async () => 'OK',
  });
  assert.equal(def.name, 'queued_tool');

  globalThis.__ccpRawTools = []; // poller (50ms) should drain into this
  await new Promise((r) => setTimeout(r, 160));

  const t = globalThis.__ccpRawTools.find((x) => x.name === 'queued_tool');
  assert.ok(t, 'queued tool was drained into __ccpRawTools');
  assert.equal(typeof t.call, 'function');
  assert.deepEqual(await t.call({}), [{ type: 'text', text: 'OK' }]);
});

// ── agent registry ────────────────────────────────────────────────────────────

test('defineAgent registers and getAgent/listAgents retrieve', () => {
  const def = defineAgent({
    name: 'reg-probe',
    description: 'a probe',
    systemPrompt: 'You probe.',
    tools: ['Read'],
  });
  assert.equal(getAgent('reg-probe'), def);
  assert.equal(getAgent('reg-probe').systemPrompt, 'You probe.');
  assert.ok(listAgents().some((a) => a.name === 'reg-probe'));
  assert.equal(getAgent('does-not-exist'), null);
});

// ── tool-registry: synchronous inject + call shape ────────────────────────────

test('defineTool injects into a live __ccpRawTools and wraps execute into call()', async () => {
  resetGlobals();
  defineTool({
    name: 'sync_tool',
    description: 'syncs',
    inputSchema: { type: 'object' },
    execute: async (input) => `got:${input.v}`,
  });
  const t = globalThis.__ccpRawTools.find((x) => x.name === 'sync_tool');
  assert.ok(t, 'tool injected synchronously when array present');
  assert.equal(t.description, 'syncs');
  assert.deepEqual(await t.call({ v: 42 }), [{ type: 'text', text: 'got:42' }]);
});

test('defineTool replaces an existing tool with the same name (no duplicates)', async () => {
  resetGlobals();
  defineTool({ name: 'dup', description: 'first', inputSchema: {}, execute: async () => 'a' });
  defineTool({ name: 'dup', description: 'second', inputSchema: {}, execute: async () => 'b' });
  const matches = globalThis.__ccpRawTools.filter((x) => x.name === 'dup');
  assert.equal(matches.length, 1, 'same-name tool overwritten in place');
  assert.equal(matches[0].description, 'second');
});

// ── defineHandoff: argument validation ────────────────────────────────────────

test('defineHandoff rejects a missing target and an unknown mode', () => {
  assert.throws(() => defineHandoff({}), /`target` must be a non-empty string/);
  assert.throws(() => defineHandoff({ target: 'x', mode: 'bogus' }), /unknown mode "bogus"/);
});

// ── defineHandoff: delegate, native (non-ADK) target ──────────────────────────

test('delegate handoff to a native target invokes __ccpAgentTool without agentDef', async () => {
  resetGlobals();
  const events = captureBus();
  const rec = stubAgentTool({ text: 'NATIVE RESULT' });

  const def = defineHandoff({ target: 'native-reviewer' });
  // Injected as a tool the model can call.
  assert.ok(globalThis.__ccpRawTools.some((x) => x.name === 'transfer_to_native-reviewer'));

  const res = await def.execute({ task: 'review the diff' });

  assert.equal(rec.last.subagent_type, 'native-reviewer');
  assert.equal(rec.last.prompt, 'review the diff');
  assert.equal(rec.last.background, false);
  assert.equal(rec.last.agentDef, undefined, 'native target carries no synthetic agentDef');
  assert.equal(res, 'NATIVE RESULT');

  assert.deepEqual(topics(events), ['handoff.start', 'handoff.end']);
  assert.equal(payloadOf(events, 'handoff.start').mode, 'delegate');
  assert.equal(payloadOf(events, 'handoff.end').ok, true);
});

// ── defineHandoff: delegate, ADK-registered target → agentDef merge ───────────

test('delegate handoff to an ADK agent passes a CC-shaped agentDef', async () => {
  resetGlobals();
  captureBus();
  const rec = stubAgentTool();
  defineAgent({
    name: 'adk-researcher',
    description: 'researches open questions',
    systemPrompt: 'You research.',
    tools: ['Read', 'Grep'],
  });

  const def = defineHandoff({ target: 'adk-researcher' });
  await def.execute({ task: 'find callers' });

  const d = rec.last.agentDef;
  assert.ok(d, 'ADK target bridges a synthetic agentDef into dispatch');
  assert.equal(d.agentType, 'adk-researcher');
  assert.equal(d.whenToUse, 'researches open questions');
  assert.deepEqual(d.tools, ['Read', 'Grep']);
  assert.equal(d.source, 'user', 'must not be built-in/plugin so CC treats it as user-provided');
  assert.equal(typeof d.getSystemPrompt, 'function');
  assert.equal(d.getSystemPrompt(), 'You research.');
});

test('delegate handoff honors a custom promptKey', async () => {
  resetGlobals();
  captureBus();
  const rec = stubAgentTool();
  const def = defineHandoff({ target: 'pk-target', promptKey: 'question' });
  assert.deepEqual(def.inputSchema.required, ['question']);
  await def.execute({ question: 'what changed?' });
  assert.equal(rec.last.prompt, 'what changed?');
});

// ── defineHandoff: swap success ───────────────────────────────────────────────

test('swap handoff overlays the target persona via __ccpSetSystemPrompt', async () => {
  resetGlobals();
  const events = captureBus();
  let overlaid = null;
  globalThis.__ccpSetSystemPrompt = (s) => {
    overlaid = s;
    return s;
  };
  defineAgent({ name: 'swap-writer', description: 'writes', systemPrompt: 'You are a writer.' });

  const def = defineHandoff({ target: 'swap-writer', mode: 'swap' });
  const res = await def.execute({ task: 'unused for swap' });

  assert.equal(overlaid, 'You are a writer.');
  assert.match(res, /persona swapped/i);
  assert.deepEqual(topics(events), ['handoff.start', 'handoff.end']);
  assert.equal(payloadOf(events, 'handoff.start').mode, 'swap');
  assert.equal(payloadOf(events, 'handoff.end').ok, true);
});

// ── defineHandoff: swap degrades to delegate when primitive is absent ─────────

test('swap handoff degrades to delegate when __ccpSetSystemPrompt is missing', async () => {
  resetGlobals(); // no __ccpSetSystemPrompt
  const events = captureBus();
  const rec = stubAgentTool({ text: 'DELEGATED' });
  defineAgent({ name: 'swap-fallback', description: 'd', systemPrompt: 'persona' });

  const def = defineHandoff({ target: 'swap-fallback', mode: 'swap' });
  const res = await def.execute({ task: 't' });

  assert.ok(topics(events).includes('handoff.degraded'), 'emits handoff.degraded');
  const deg = payloadOf(events, 'handoff.degraded');
  assert.equal(deg.requested, 'swap');
  assert.equal(deg.used, 'delegate');
  // Effective mode is delegate: the subagent actually ran.
  assert.equal(rec.last.subagent_type, 'swap-fallback');
  assert.equal(res, 'DELEGATED');
  assert.equal(payloadOf(events, 'handoff.start').mode, 'delegate');
});

// ── defineHandoff: failure is returned as text, end event marked not-ok ───────

test('delegate handoff with no __ccpAgentTool returns a readable failure string', async () => {
  resetGlobals(); // no __ccpAgentTool
  const events = captureBus();
  const def = defineHandoff({ target: 'unreachable' });
  const res = await def.execute({ task: 't' });
  assert.match(res, /Handoff to "unreachable" failed:/);
  assert.equal(payloadOf(events, 'handoff.end').ok, false);
});

// ── AgentRouter (secondary, predicate-driven path) ────────────────────────────

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test('AgentRouter.register rejects an agent without a name', () => {
  assert.throws(() => new AgentRouter().register({}), /name must be a non-empty string/);
  assert.throws(() => new AgentRouter().register(null), /name must be a non-empty string/);
});

test('AgentRouter installs personas and follows a converging predicate chain', async () => {
  const submitted = [];
  globalThis.__ccpSubmitInput = async (s) => { submitted.push(s); };
  try {
    const router = new AgentRouter();
    router.register({ name: 'rt-a', systemPrompt: 'PROMPT_A', handoff: () => 'rt-b' });
    router.register({ name: 'rt-b', systemPrompt: 'PROMPT_B', handoff: () => null });
    const transitions = [];
    router.on('transition', (t) => transitions.push(t));

    await router.start('rt-a');
    await tick();

    assert.deepEqual(transitions, [{ from: 'rt-a', to: 'rt-b' }]);
    assert.equal(router.active, 'rt-b');
    assert.deepEqual(submitted, ['PROMPT_A', 'PROMPT_B']);
  } finally {
    delete globalThis.__ccpSubmitInput;
  }
});

test('AgentRouter caps runaway ping-pong transitions and emits limit', async () => {
  globalThis.__ccpSubmitInput = async () => {};
  try {
    const router = new AgentRouter({ maxTransitions: 3 });
    router.register({ name: 'p-a', systemPrompt: 'A', handoff: () => 'p-b' });
    router.register({ name: 'p-b', systemPrompt: 'B', handoff: () => 'p-a' });
    let count = 0;
    router.on('transition', () => count++);
    const limit = new Promise((res) => router.once('limit', res));

    await router.start('p-a');
    const payload = await limit;

    assert.equal(payload.transitions, 3);
    assert.equal(count, 3, 'halts exactly at the cap');
  } finally {
    delete globalThis.__ccpSubmitInput;
  }
});

test('AgentRouter.stop() halts the chain before the next transition', async () => {
  globalThis.__ccpSubmitInput = async () => {};
  try {
    const router = new AgentRouter();
    router.register({
      name: 's-a',
      systemPrompt: 'A',
      handoff: () => { router.stop(); return 's-b'; },
    });
    router.register({ name: 's-b', systemPrompt: 'B', handoff: () => 's-a' });
    const transitions = [];
    router.on('transition', (t) => transitions.push(t));

    await router.start('s-a');
    await tick();

    assert.equal(transitions.length, 0, 'stop() suppresses the pending transition');
    assert.equal(router.active, 's-a');
  } finally {
    delete globalThis.__ccpSubmitInput;
  }
});

// ── expose_system_prompt: overlay scoping by __ccp_path (vm Layer-3) ───────────

/** Mirrors tests/patch-verification.test.mjs makeSandbox. */
function makeSandbox() {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => {},
    clearTimeout: () => {},
    process: { env: {}, argv: [], versions: { node: '20.0.0' } },
  };
  ctx.globalThis = ctx;
  return ctx;
}

test('expose_system_prompt scopes the overlay to main-loop queries via __ccp_path', () => {
  // Minimal fixture: a shebang (spliceBoot site) + the system-prompt assembly anchor.
  const FIXTURE =
    '#!/usr/bin/env node\n' +
    'const Q9=u9([G0({isNonInteractive:a,hasAppendSystemPrompt:b}),...x].filter(Boolean));\n';

  const applied = expose.apply(FIXTURE);
  assert.ok(
    applied.includes('globalThis.__ccpApplySystemPromptOverride('),
    'apply() rewrote the assembly site',
  );

  // Run the patched body in a sandbox. The trailing const references undefined
  // minified vars (u9/G0/x) → ReferenceError, which we swallow exactly like the
  // existing Layer-3 harness; the boot IIFE has already registered the globals.
  const body = applied.replace(/^#!.*\n/, '');
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  try {
    new vm.Script(body).runInContext(sandbox);
  } catch (e) {
    if (!/is not defined/.test(e.message)) throw e;
  }

  assert.equal(typeof sandbox.__ccpApplySystemPromptOverride, 'function');
  // The writer is now nonce-gated — acquire the load-time nonce and pass it as
  // the FIRST arg, mirroring how a trusted caller obtains it at startup.
  assert.equal(typeof sandbox.__ccpGetSystemPromptNonce, 'function');
  const spNonce = sandbox.__ccpGetSystemPromptNonce();
  sandbox.__ccpSetSystemPrompt(spNonce, 'PERSONA');

  // Main loop: __ccp_path unset → overlay applied. (Assert field-by-field: the
  // block is constructed inside the vm realm, so its prototype is not
  // reference-equal to this realm's Object and deepStrictEqual would reject it.)
  let out = sandbox.__ccpApplySystemPromptOverride([]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].text, 'PERSONA');

  // Explicit "root" → still main loop → applied.
  sandbox.__ccp_path = 'root';
  assert.equal(sandbox.__ccpApplySystemPromptOverride([]).length, 1);

  // Inside a subagent (non-root path) → overlay suppressed.
  sandbox.__ccp_path = 'root/abc123';
  assert.equal(sandbox.__ccpApplySystemPromptOverride([]).length, 0);

  // Cleared overlay → never applied.
  sandbox.__ccp_path = 'root';
  sandbox.__ccpSetSystemPrompt(spNonce, null);
  assert.equal(sandbox.__ccpApplySystemPromptOverride([]).length, 0);

  // Wrong/absent nonce is rejected (writer is gated; reader is not).
  assert.throws(() => sandbox.__ccpSetSystemPrompt('bogus', 'X'), /invalid nonce/);
  assert.throws(() => sandbox.__ccpSetSystemPrompt('PERSONA'), /invalid nonce/);
});

// ── nonce-gated swap writer (handoff side) ────────────────────────────────────

test('swap uses the GATED writer — passes the nonce as the first arg', async () => {
  resetGlobals();
  captureBus();
  // Model the nonce-gated host: a writer that REQUIRES the correct nonce.
  const NONCE = 'sp-nonce-xyz';
  let lastValue = 'ORIGINAL';
  globalThis.__ccpGetSystemPromptNonce = () => NONCE;
  globalThis.__ccpSetSystemPrompt = (callerNonce, value) => {
    if (callerNonce !== NONCE) throw new Error('invalid nonce');
    lastValue = value;
    return value;
  };
  globalThis.__ccpGetSystemPrompt = () => lastValue;

  defineAgent({ name: 'gated-writer', description: 'w', systemPrompt: 'GATED PERSONA' });
  const def = defineHandoff({ target: 'gated-writer', mode: 'swap' });
  const res = await def.execute({ task: 'x' });

  assert.match(res, /persona swapped/i);
  assert.equal(lastValue, 'GATED PERSONA', 'gated writer received the new persona with the right nonce');
  assert.equal(currentPersona(), 'GATED PERSONA', 'currentPersona() reads the live overlay');
});

test('swap with the WRONG nonce throws inside the gated writer', async () => {
  resetGlobals();
  captureBus();
  // A getter that lies — returns a nonce the writer will reject. This proves the
  // handoff actually forwards getNonce()'s value (not a hardcoded one).
  globalThis.__ccpGetSystemPromptNonce = () => 'WRONG';
  globalThis.__ccpSetSystemPrompt = (callerNonce) => {
    if (callerNonce !== 'RIGHT') throw new Error('__ccpSetSystemPrompt: invalid nonce. Call __ccpGetSystemPromptNonce() at startup.');
  };
  defineAgent({ name: 'bad-nonce', description: 'w', systemPrompt: 'P' });
  const def = defineHandoff({ target: 'bad-nonce', mode: 'swap' });
  const res = await def.execute({ task: 'x' });
  // setLiveSystemPrompt throws → caught → readable failure tool_result.
  assert.match(res, /failed:.*invalid nonce/i);
});

test('swap uses the LEGACY single-arg writer when no nonce getter exists', async () => {
  resetGlobals();
  captureBus();
  // No __ccpGetSystemPromptNonce — the helper must fall back to single-arg.
  const calls = [];
  globalThis.__ccpSetSystemPrompt = (...args) => { calls.push(args); return args[0]; };
  defineAgent({ name: 'legacy-writer', description: 'w', systemPrompt: 'LEGACY PERSONA' });
  const def = defineHandoff({ target: 'legacy-writer', mode: 'swap' });
  const res = await def.execute({ task: 'x' });

  assert.match(res, /persona swapped/i);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['LEGACY PERSONA'], 'legacy host called with a single (value) arg, no nonce');
});

// ── cross-instance swap isolation over ONE global slot ────────────────────────

test('two ADK instances share ONE live slot without clobbering each other (LIFO ownership)', async () => {
  resetGlobals();
  captureBus();
  // Model the host's SINGLE live persona slot (legacy single-arg writer is fine).
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  // Two independent ADK instances: separate agent registries + handoff scopes,
  // both writing through the SAME single slot.
  const scopeA = createHandoffScope();
  const scopeB = createHandoffScope();
  const regA = createAgentScope();
  const regB = createAgentScope();
  defineAgentIn(regA, { name: 'persona-A', systemPrompt: 'PERSONA_A' });
  defineAgentIn(regB, { name: 'persona-B', systemPrompt: 'PERSONA_B' });

  const defA = createDefineHandoff({ scope: scopeA, getAgent: (n) => getAgentIn(regA, n), defineTool });
  const defB = createDefineHandoff({ scope: scopeB, getAgent: (n) => getAgentIn(regB, n), defineTool });

  // A swaps in PERSONA_A, then B swaps in PERSONA_B (well-nested: B is on top).
  await defA({ target: 'persona-A', mode: 'swap' }).execute({ task: 't' });
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA_A');
  await defB({ target: 'persona-B', mode: 'swap' }).execute({ task: 't' });
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA_B');

  assert.equal(swapDepthIn(scopeA), 1, 'A owns exactly one global entry');
  assert.equal(swapDepthIn(scopeB), 1, 'B owns exactly one global entry');

  // OUT-OF-ORDER restore: A tries to restore while B owns the TOP. It must NOT
  // clobber B's live persona — returns false, slot intact, B still owns its entry.
  const realWarn = console.warn;
  console.warn = () => {};
  const aOutOfOrder = restoreSystemPromptIn(scopeA);
  console.warn = realWarn;
  assert.equal(aOutOfOrder, false, 'A cannot restore — it does not own the top of the stack');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA_B', 'B’s live persona is untouched');
  assert.equal(swapDepthIn(scopeB), 1, 'B still owns its entry after A’s refused restore');

  // Proper LIFO: B restores first (pops B → reveals A), then A restores (→ BASE).
  assert.equal(restoreSystemPromptIn(scopeB), true);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA_A', 'B pop reveals A’s persona');
  assert.equal(restoreSystemPromptIn(scopeA), true);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'A pop returns to BASE');
});

// ── TOCTOU pin — persona changed after definition is refused ──────────────────

test('swap refuses when the target persona is mutated after the handoff is defined', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'pinned', systemPrompt: 'TRUSTED PERSONA' });
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });

  // Handoff defined NOW → pins sha256('TRUSTED PERSONA').
  const handle = define({ target: 'pinned', mode: 'swap', allowSwapTargets: ['pinned'] });

  // Attacker re-defines the same allowlisted name with a hostile persona.
  defineAgentIn(reg, { name: 'pinned', systemPrompt: 'HOSTILE PERSONA' });

  const realWarn = console.warn;
  console.warn = () => {};
  const res = await handle.execute({ task: 'x' });
  console.warn = realWarn;
  assert.match(res, /persona changed since handoff was defined; refusing swap/);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'ORIGINAL', 'live persona unchanged — swap refused');
  assert.ok(topics(events).includes('handoff.pin.mismatch'), 'emits handoff.pin.mismatch');
  assert.equal(payloadOf(events, 'handoff.end').ok, false, 'end event marked not-ok');
});

test('swap with an unchanged pinned persona still proceeds', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'stable', systemPrompt: 'STABLE PERSONA' });
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  const handle = define({ target: 'stable', mode: 'swap' });

  const res = await handle.execute({ task: 'x' });
  assert.match(res, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'STABLE PERSONA');
});

test('swap against an unregistered-at-define target emits handoff.pin.deferred', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  // Defined BEFORE the agent exists → nothing to pin. allowDeferredPin opts into
  // the legacy pin-on-first-resolve path (the default now throws — see the
  // "refuses an unregistered swap target by default" test below).
  const handle = define({ target: 'later', mode: 'swap', allowDeferredPin: true });
  // Agent appears afterward.
  defineAgentIn(reg, { name: 'later', systemPrompt: 'LATE PERSONA' });

  const res = await handle.execute({ task: 'x' });
  assert.match(res, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'LATE PERSONA');
  assert.ok(topics(events).includes('handoff.pin.deferred'), 'emits handoff.pin.deferred');
});

test('defineHandoff refuses an unregistered swap target by default (TOCTOU window closed)', () => {
  resetGlobals();
  const reg = createAgentScope();
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  // No agent "ghost" registered → default behavior must THROW at definition time
  // rather than silently deferring the pin (the define→first-execute window).
  assert.throws(
    () => define({ target: 'ghost', mode: 'swap' }),
    /not registered.*allowDeferredPin/s,
    'unregistered swap target throws unless allowDeferredPin is set',
  );
  // The escape hatch still allows the deferred path.
  assert.doesNotThrow(() => define({ target: 'ghost', mode: 'swap', allowDeferredPin: true }));
  // delegate mode is unaffected — it never pins a persona.
  assert.doesNotThrow(() => define({ target: 'ghost', mode: 'delegate' }));
});

// ── AgentRouter announces code-driven control on first submit ─────────────────

test('AgentRouter emits router.active on the bus the first time it submits', async () => {
  const events = captureBus();
  globalThis.__ccpSubmitInput = async () => {};
  try {
    const router = new AgentRouter();
    router.register({ name: 'r-a', systemPrompt: 'A', handoff: () => 'r-b' });
    router.register({ name: 'r-b', systemPrompt: 'B', handoff: () => null });
    await router.start('r-a');
    await tick();
    const actives = events.filter((e) => e.topic === 'router.active');
    assert.equal(actives.length, 1, 'router.active fires exactly once');
    assert.equal(actives[0].payload.agent, 'r-a', 'announces the first driven agent');
  } finally {
    delete globalThis.__ccpSubmitInput;
    delete globalThis.__ccpBus;
  }
});

// ── exclusive swap-lock token (tryAcquireSwap) ────────────────────────────────

test('tryAcquireSwap grants a token, refuses a second scope, releases the lock', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const scopeA = createHandoffScope();
  const scopeB = createHandoffScope();

  const tokA = tryAcquireSwap(scopeA);
  assert.ok(tokA, 'first acquire returns a token');
  assert.equal(tokA.owned, true);

  // While A holds the lock, B is refused.
  assert.equal(tryAcquireSwap(scopeB), null, 'second scope refused while A holds the lock');
  // Re-acquire from the SAME scope returns the SAME memoized token (idempotent
  // ownership), NOT a fresh independent one. SOUNDNESS FIX: there is a single
  // non-refcounted lockOwner; a fresh token over that shared lock state is unsound
  // — releasing one token would free the lock while the other still believes it
  // owns it, letting a different scope acquire while the first can still swap().
  assert.equal(tryAcquireSwap(scopeA), tokA, 'same scope re-acquire returns the SAME token');

  tokA.swap('PERSONA_A');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA_A');
  assert.equal(swapDepthIn(scopeA), 1);

  // release() restores remaining owned entries (→ BASE) and drops the lock.
  tokA.release();
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'release restored the displaced prompt');
  assert.equal(tokA.owned, false);
  assert.equal(swapDepthIn(scopeA), 0);

  // Now B can acquire.
  const tokB = tryAcquireSwap(scopeB);
  assert.ok(tokB, 'B acquires after A released');
  tokB.release();
});

// FIX #2 regression: a same-scope re-acquire must NOT mint a fresh independent
// token over the single non-refcounted lock. Acquire twice (same scope), release
// ONCE — the lock must remain held (no other scope can acquire) as long as a live
// token exists, and only an actual release frees it.
test('tryAcquireSwap re-acquire is idempotent — releasing one view does not leak the lock', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const scopeA = createHandoffScope();
  const scopeB = createHandoffScope();

  const tok1 = tryAcquireSwap(scopeA);
  const tok2 = tryAcquireSwap(scopeA); // same scope re-acquire
  assert.equal(tok1, tok2, 're-acquire returns the SAME token object (idempotent ownership)');

  // Releasing the (single) token frees the lock exactly once — there is no second
  // independent token whose release could have prematurely freed it while the
  // other still believed it owned the slot.
  tok1.release();
  assert.equal(tok1.owned, false, 'token no longer owns the lock after release');
  assert.equal(tok2.owned, false, 'the aliased view reflects the same released state');

  // Now — and only now — a DIFFERENT scope can acquire.
  const tokB = tryAcquireSwap(scopeB);
  assert.ok(tokB, 'lock acquirable by another scope only after the live token released');
  tokB.release();
});

test('tryAcquireSwap token.swap after release throws; events fire on acquire/release', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const scope = createHandoffScope();
  const tok = tryAcquireSwap(scope);
  tok.release();
  assert.throws(() => tok.swap('X'), /token released/);
  assert.ok(topics(events).includes('handoff.swap.acquire'), 'emits handoff.swap.acquire');
  assert.ok(topics(events).includes('handoff.swap.release'), 'emits handoff.swap.release');
  // release() is idempotent.
  tok.release();
});

test('tryAcquireSwap token.restore honors LIFO over the shared stack', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const scope = createHandoffScope();
  const tok = tryAcquireSwap(scope);
  tok.swap('P1');
  tok.swap('P2');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'P2');
  assert.equal(tok.restore(), true);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'P1', 'LIFO pop reveals P1');
  assert.equal(tok.restore(), true);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE');
  tok.release();
});

test('swap stack is capped at MAX_SWAP_DEPTH — a runaway swap chain is refused', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const scope = createHandoffScope();
  const tok = tryAcquireSwap(scope);
  // MAX_SWAP_DEPTH is 64 (not exported); push to the cap, then expect refusal.
  for (let i = 0; i < 64; i++) tok.swap(`P${i}`);
  assert.equal(swapDepthIn(scope), 64, 'stack filled to the cap');

  // The 65th swap is refused (throws) and does NOT change the live persona.
  const beforeRefusal = globalThis.__ccpSystemPromptOverride;
  assert.throws(() => tok.swap('OVERFLOW'), /MAX_SWAP_DEPTH/);
  assert.equal(globalThis.__ccpSystemPromptOverride, beforeRefusal, 'refused swap left the live persona untouched');
  assert.equal(swapDepthIn(scope), 64, 'depth unchanged by the refused swap');
  assert.ok(topics(events).includes('handoff.swap.depthExceeded'), 'emits handoff.swap.depthExceeded');

  tok.release();
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'release unwinds the whole stack');
});

// Regression for COD-10: depthOf()/swapDepthIn() is now backed by an O(1)
// per-scope counter maintained on push/restore instead of an O(n) stack walk.
// This pins that the counter stays EXACTLY correct across nested push/restore —
// monotonically up on each swap, down on each LIFO restore, back to 0 on full
// unwind (exercising the delete-at-0 path), and correct again after re-swapping.
test('swap depth tracking stays correct across nested push/restore (COD-10)', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const scope = createHandoffScope();
  const tok = tryAcquireSwap(scope);
  assert.equal(swapDepthIn(scope), 0, 'depth starts at 0');

  // Push five nested swaps — depth must increment by exactly one each time.
  for (let i = 1; i <= 5; i++) {
    tok.swap(`P${i}`);
    assert.equal(swapDepthIn(scope), i, `depth is ${i} after push #${i}`);
  }

  // Pop them LIFO — depth must decrement by exactly one each time, to 0.
  for (let i = 4; i >= 0; i--) {
    assert.equal(tok.restore(), true, `restore #${5 - i} pops an owned entry`);
    assert.equal(swapDepthIn(scope), i, `depth is ${i} after restore`);
  }
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'fully unwound to BASE');

  // After a full unwind (counter key deleted at 0), a fresh swap still tracks
  // from 1 — the counter is not stuck at a stale value.
  tok.swap('AGAIN');
  assert.equal(swapDepthIn(scope), 1, 'depth re-tracks from 1 after a full unwind');

  tok.release();
  assert.equal(swapDepthIn(scope), 0, 'release drains the depth back to 0');
});

// ── swap enforces the agent tools allowlist on the live tool surface ──────────

test('swap restricts the live tool surface to the agent tools allowlist and restores on revert', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
  // Seed the live surface with a host tool the read-only persona must NOT keep.
  globalThis.__ccpRawTools.push({ name: 'Bash', call: async () => [] }, { name: 'Read', call: async () => [] });

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'reader', systemPrompt: 'READER', tools: ['Read'] });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  await define({ target: 'reader', mode: 'swap' }).execute({ task: 'go' });
  const names = () => globalThis.__ccpRawTools.map((t) => t.name);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'READER', 'persona swapped in');
  assert.ok(names().includes('Read'), 'allowlisted tool kept');
  assert.ok(!names().includes('Bash'), 'disallowed host tool hidden');
  assert.ok(names().includes('transfer_back'), 'revert affordance always kept regardless of allowlist');

  const restricted = payloadOf(events, 'handoff.tools.restricted');
  assert.ok(restricted, 'emits handoff.tools.restricted');
  assert.ok(restricted.removed.includes('Bash'), 'event lists the hidden tool');
  assert.ok(!restricted.removed.includes('Read'), 'event does not list a kept tool');

  // Revert re-adds exactly what the swap hid.
  assert.equal(restoreSystemPromptIn(scope), true);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'persona reverted');
  assert.ok(names().includes('Bash'), 'hidden tool re-added on revert');
});

// FIX #1 regression: restore() must attempt the (fallible) write BEFORE popping.
// If the host writer throws on the restore write, the stack entry, the hidden
// tools, and the depth must all be INTACT (no partial corruption) and restore()
// must return false. A pop-before-write ordering would strand the tools hidden
// and wrongly decrement depth while leaving the persona NOT restored.
test('restore() leaves stack/tools/depth intact when the restore write throws', async () => {
  resetGlobals();
  captureBus();
  // Live slot writer: succeeds for the swap-IN value, but THROWS when asked to
  // write back the prior 'BASE' prompt (simulates a wedged host on the restore
  // write specifically).
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => {
    if (s === 'BASE') throw new Error('writer wedged on restore');
    globalThis.__ccpSystemPromptOverride = s;
  };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
  // Seed a host tool the swap will hide so we can prove tools are NOT stranded.
  globalThis.__ccpRawTools.push({ name: 'Bash', call: async () => [] });

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'rdr', systemPrompt: 'RDR', tools: ['Read'] });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  await define({ target: 'rdr', mode: 'swap' }).execute({ task: 'go' });
  assert.equal(globalThis.__ccpSystemPromptOverride, 'RDR', 'persona swapped in');
  assert.equal(swapDepthIn(scope), 1, 'one owned entry after swap');
  const names = () => globalThis.__ccpRawTools.map((t) => t.name);
  assert.ok(!names().includes('Bash'), 'Bash hidden by the swap');

  // The restore write throws → restore() returns false WITHOUT mutating state.
  const ok = restoreSystemPromptIn(scope);
  assert.equal(ok, false, 'restore returns false when the writer throws');
  assert.equal(swapDepthIn(scope), 1, 'depth NOT decremented on a failed restore');
  assert.ok(!names().includes('Bash'), 'hidden tool NOT stranded-restored — entry intact');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'RDR', 'persona unchanged (write never landed)');

  // Heal the host and prove the SAME entry can still be reverted (no corruption).
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  assert.equal(restoreSystemPromptIn(scope), true, 'restore succeeds once the writer recovers');
  assert.equal(swapDepthIn(scope), 0, 'entry popped only after the write landed');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'persona reverted to BASE');
  assert.ok(names().includes('Bash'), 'hidden tool re-added on the successful revert');
});

test('swap with a wildcard / empty tools allowlist does NOT restrict the live surface', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
  globalThis.__ccpRawTools.push({ name: 'Bash', call: async () => [] });

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'wild', systemPrompt: 'WILD', tools: ['*'] });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  await define({ target: 'wild', mode: 'swap' }).execute({ task: 'go' });
  assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'Bash'), 'wildcard allowlist leaves the surface intact');
  restoreSystemPromptIn(scope);
});

// ── pin-on-first-resolve for the deferred case ────────────────────────────────

test('deferred-pin captures the persona on first resolve and refuses later drift', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  // Target unregistered at define time → pin deferred (opt-in via allowDeferredPin).
  const handle = define({ target: 'deferred', mode: 'swap', allowSwapTargets: ['deferred'], allowDeferredPin: true });

  // First resolve: agent now exists. Captures the pin on this very first execute.
  defineAgentIn(reg, { name: 'deferred', systemPrompt: 'FIRST PERSONA' });
  const res1 = await handle.execute({ task: 'x' });
  assert.match(res1, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'FIRST PERSONA');
  assert.ok(topics(events).includes('handoff.pin.deferred'), 'pin.deferred fires on first resolve only');
  assert.ok(topics(events).includes('handoff.pin.captured'), 'pin.captured fires on first capture');

  // Restore back to ORIGINAL so the next swap has a clean slot.
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';

  // Attacker re-defines the same name with a hostile persona AFTER first capture.
  defineAgentIn(reg, { name: 'deferred', systemPrompt: 'HOSTILE PERSONA' });

  const realWarn = console.warn;
  console.warn = () => {};
  const res2 = await handle.execute({ task: 'x' });
  console.warn = realWarn;
  assert.match(res2, /persona changed since handoff was defined; refusing swap/);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'ORIGINAL', 'drifted swap refused');
  assert.ok(topics(events).includes('handoff.pin.mismatch'), 'second execute refused via pin.mismatch');
});

test('deferred-pin does NOT re-emit pin.deferred on subsequent (unchanged) executes', async () => {
  resetGlobals();
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  const handle = define({ target: 'd2', mode: 'swap', allowDeferredPin: true });
  defineAgentIn(reg, { name: 'd2', systemPrompt: 'STABLE' });

  const events1 = captureBus();
  await handle.execute({ task: 'x' });
  assert.ok(topics(events1).includes('handoff.pin.deferred'), 'first resolve emits pin.deferred');

  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  const events2 = captureBus();
  const res2 = await handle.execute({ task: 'x' });
  assert.match(res2, /persona swapped/i);
  assert.equal(topics(events2).includes('handoff.pin.deferred'), false, 'no pin.deferred on the second execute');
});

// ── AgentRouter.start() submit cap + control-char sanitization ────────────────

test('AgentRouter sanitizes control chars (keeps newline/tab) before submitting', async () => {
  resetGlobals();
  const submitted = [];
  globalThis.__ccpSubmitInput = async (s) => { submitted.push(s); };
  try {
    const router = new AgentRouter();
    router.register({ name: 'c-a', systemPrompt: 'a bc\nd\te', handoff: () => null });
    await router.start('c-a');
    await tick();
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0], 'abc\nd\te', 'C0 control chars stripped, newline+tab preserved');
  } finally {
    delete globalThis.__ccpSubmitInput;
  }
});

test('AgentRouter refuses an over-cap submit: rejects, errors, does not advance', async () => {
  resetGlobals();
  const events = captureBus();
  const submitted = [];
  globalThis.__ccpSubmitInput = async (s) => { submitted.push(s); };
  try {
    const huge = 'x'.repeat(128 * 1024 + 1);
    const router = new AgentRouter();
    let nextScheduled = false;
    router.register({ name: 'big', systemPrompt: huge, handoff: () => { nextScheduled = true; return 'small'; } });
    router.register({ name: 'small', systemPrompt: 'ok', handoff: () => null });
    const errors = [];
    router.on('error', (e) => errors.push(e));

    await router.start('big');
    await tick();

    assert.equal(submitted.length, 0, 'oversized persona was not submitted');
    assert.equal(nextScheduled, false, 'chain did not advance past the refused submit');
    assert.equal(errors.length, 1, 'router error event fired (observed)');
    assert.equal(errors[0].phase, 'submit');
    assert.ok(topics(events).includes('router.submit.rejected'), 'fires router.submit.rejected');
    const rej = payloadOf(events, 'router.submit.rejected');
    assert.equal(rej.max, 128 * 1024);
    assert.ok(rej.bytes > rej.max);
  } finally {
    delete globalThis.__ccpSubmitInput;
  }
});

// ── drift guard load-bearing at the write call site ──────────────────────────

test('setLiveSystemPrompt refuses the write when the systemPrompt contract is drifted', async () => {
  resetGlobals();
  // Earlier tests run swaps with no contract registered, which (correctly) take
  // the fail-open path. Clear the drift latch so this case starts fresh — the
  // guard re-evaluates against THIS test's registered-but-drifted contract.
  __resetSystemPromptDriftGuardForTests();
  captureBus();
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
  // A registered-but-drifted systemPrompt contract: inspect lists it, require throws.
  globalThis.__ccpInspectContracts = () => [{ name: 'systemPrompt', version: 1, producer: 'p', shape: [] }];
  globalThis.__ccpRequire = (name) => {
    if (name === 'systemPrompt') throw new Error('[ccp:contract] systemPrompt v1 < required v2');
    return undefined;
  };

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'drift', systemPrompt: 'P' });
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  const handle = define({ target: 'drift', mode: 'swap' });

  const res = await handle.execute({ task: 'x' });
  // setLiveSystemPrompt throws inside the swap → caught → readable failure.
  assert.match(res, /failed:.*v1 < required v2/);
  assert.notEqual(globalThis.__ccpSystemPromptOverride, 'P', 'drifted write refused — slot untouched');
});

test('drift guard fails OPEN when require/inspect are absent or the contract is unregistered', async () => {
  resetGlobals();
  captureBus();
  // No __ccpRequire / __ccpInspectContracts at all → bare-global stub path proceeds.
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'open', systemPrompt: 'OPEN PERSONA' });
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  const handle = define({ target: 'open', mode: 'swap' });
  const res = await handle.execute({ task: 'x' });
  assert.match(res, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'OPEN PERSONA', 'fail-open: write proceeded');
});

test('drift guard honors a contract registry that populates AFTER the first swap', async () => {
  resetGlobals();
  __resetSystemPromptDriftGuardForTests();
  captureBus();
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'late', systemPrompt: 'LATE OK' });
  const define = createDefineHandoff({ scope: createHandoffScope(), getAgent: (n) => getAgentIn(reg, n), defineTool });
  const handle = define({ target: 'late', mode: 'swap' });

  // FIRST swap: no contract registry yet → fail-open path proceeds. The guard
  // must NOT latch this fail-open decision.
  const res1 = await handle.execute({ task: 'x' });
  assert.match(res1, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'LATE OK', 'first swap proceeds (no contract yet)');

  // Registry populates LATE with a DRIFTED systemPrompt contract.
  globalThis.__ccpSystemPromptOverride = 'ORIGINAL';
  globalThis.__ccpInspectContracts = () => [{ name: 'systemPrompt', version: 1, producer: 'p', shape: [] }];
  globalThis.__ccpRequire = (name) => {
    if (name === 'systemPrompt') throw new Error('[ccp:contract] systemPrompt v1 < required v2');
    return undefined;
  };

  // SECOND swap: the late-registered drifted contract MUST now be enforced —
  // proving the earlier fail-open was not latched forever.
  const res2 = await handle.execute({ task: 'x' });
  assert.match(res2, /failed:.*v1 < required v2/, 'late-registered drift is enforced');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'ORIGINAL', 'drifted write refused — slot untouched');
});

// FIX #3 regression: the drift guard must NOT run on the restore-to-prior write.
// Swap succeeds (contract clean), THEN the contract drifts mid-session; reverting
// to the already-validated prior persona must still succeed — a newly-drifted
// contract must never wedge the back-out path. The forward swap-in write keeps
// the check (covered by the drift tests above).
test('restore succeeds even when the systemPrompt contract drifts AFTER a successful swap', async () => {
  resetGlobals();
  __resetSystemPromptDriftGuardForTests();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'drifter', systemPrompt: 'DRIFTER' });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  // Forward swap-in: contract clean (unregistered → fail-open) → succeeds.
  const res = await define({ target: 'drifter', mode: 'swap' }).execute({ task: 'x' });
  assert.match(res, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'DRIFTER', 'persona swapped in');

  // Now the contract DRIFTS mid-session. A forward write would be refused; the
  // restore-to-prior write must NOT be (skipContractCheck on the back-out path).
  globalThis.__ccpInspectContracts = () => [{ name: 'systemPrompt', version: 1, producer: 'p', shape: [] }];
  globalThis.__ccpRequire = (name) => {
    if (name === 'systemPrompt') throw new Error('[ccp:contract] systemPrompt v1 < required v2');
    return undefined;
  };

  assert.equal(restoreSystemPromptIn(scope), true, 'restore is not blocked by a freshly-drifted contract');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'reverted to the prior known-good persona');
  assert.equal(swapDepthIn(scope), 0, 'entry popped after the successful restore');
});

// FIX #4 regression: the out-of-order-restore warning is rate-limited PER scope
// pair, not muted process-wide by a one-shot latch. A benign skip for one pair
// must NOT silence a later, distinct (dangerous) pair — each warns once, and the
// bus event fires every time regardless.
test('out-of-order restore warns once per scope pair, not once per process', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const regA = createAgentScope();
  const regB = createAgentScope();
  const regC = createAgentScope();
  defineAgentIn(regA, { name: 'pa', systemPrompt: 'PA' });
  defineAgentIn(regB, { name: 'pb', systemPrompt: 'PB' });
  defineAgentIn(regC, { name: 'pc', systemPrompt: 'PC' });
  const scopeA = createHandoffScope();
  const scopeB = createHandoffScope();
  const scopeC = createHandoffScope();
  const defA = createDefineHandoff({ scope: scopeA, getAgent: (n) => getAgentIn(regA, n), defineTool });
  const defB = createDefineHandoff({ scope: scopeB, getAgent: (n) => getAgentIn(regB, n), defineTool });
  const defC = createDefineHandoff({ scope: scopeC, getAgent: (n) => getAgentIn(regC, n), defineTool });

  // A, then B, then C swap (C on top).
  await defA({ target: 'pa', mode: 'swap' }).execute({ task: 't' });
  await defB({ target: 'pb', mode: 'swap' }).execute({ task: 't' });
  await defC({ target: 'pc', mode: 'swap' }).execute({ task: 't' });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => { warnings.push(msg); };
  try {
    // Pair (C, A): out-of-order. Warns once for this pair; repeat is rate-limited.
    assert.equal(restoreSystemPromptIn(scopeA), false);
    assert.equal(restoreSystemPromptIn(scopeA), false);
    // A DIFFERENT dangerous pair (C, B) must STILL warn — not muted by the first.
    assert.equal(restoreSystemPromptIn(scopeB), false);
  } finally {
    console.warn = realWarn;
  }

  assert.equal(warnings.length, 2, 'one warning per distinct scope pair (not 1, not 3)');
  // The bus event fires for EVERY skipped restore (3 calls), unconditionally.
  assert.equal(topics(events).filter((t) => t === 'handoff.restore.skipped').length, 3,
    'restore.skipped bus event fires on every out-of-order restore');

  // Clean up the stack (LIFO).
  console.warn = () => {};
  restoreSystemPromptIn(scopeC);
  restoreSystemPromptIn(scopeB);
  restoreSystemPromptIn(scopeA);
  console.warn = realWarn;
});

// ── disposeHandoffScope tears down swap footprint, idempotent ─────────────────

test('disposeHandoffScope restores owned entries, releases lock, unregisters transfer_back', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'dh', systemPrompt: 'PERSONA_DH' });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  // Swap installs an entry AND auto-registers transfer_back into __ccpRawTools.
  await define({ target: 'dh', mode: 'swap' }).execute({ task: 'x' });
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PERSONA_DH');
  assert.equal(swapDepthIn(scope), 1);
  assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'transfer_back'), 'transfer_back registered');

  // Hold the exclusive lock too, to prove dispose releases it.
  // (Same scope, so acquire is permitted.)
  const tok = tryAcquireSwap(scope);
  assert.ok(tok);

  const count = disposeHandoffScope(scope);
  assert.equal(count, 1, 'restored exactly one owned entry');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'BASE', 'live persona restored to BASE');
  assert.equal(swapDepthIn(scope), 0, 'no owned entries remain');
  assert.equal(globalThis.__ccpRawTools.some((t) => t.name === 'transfer_back'), false, 'transfer_back unregistered');
  // Lock released → another scope can now acquire.
  assert.ok(tryAcquireSwap(createHandoffScope()), 'lock released by dispose');

  // Idempotent: a second dispose restores nothing and does not throw.
  assert.equal(disposeHandoffScope(scope), 0, 'second dispose is a no-op');
});

test('disposeHandoffScope leaves another instance’s entry untouched (single slot honesty)', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const regA = createAgentScope();
  const regB = createAgentScope();
  defineAgentIn(regA, { name: 'pa', systemPrompt: 'PA' });
  defineAgentIn(regB, { name: 'pb', systemPrompt: 'PB' });
  const scopeA = createHandoffScope();
  const scopeB = createHandoffScope();
  const defA = createDefineHandoff({ scope: scopeA, getAgent: (n) => getAgentIn(regA, n), defineTool });
  const defB = createDefineHandoff({ scope: scopeB, getAgent: (n) => getAgentIn(regB, n), defineTool });

  await defA({ target: 'pa', mode: 'swap' }).execute({ task: 't' });
  await defB({ target: 'pb', mode: 'swap' }).execute({ task: 't' });
  // B is on top. Disposing A must NOT clobber B's live persona.
  const count = disposeHandoffScope(scopeA);
  assert.equal(count, 0, 'A owns no top entry → nothing restored');
  assert.equal(globalThis.__ccpSystemPromptOverride, 'PB', 'B live persona untouched');
  assert.equal(swapDepthIn(scopeA), 1, 'A entry preserved beneath B (cannot pop out of order)');
});

// ── swap tool hide/restore routes through the nonce-gated registrar ────────────

test('swap hides/restores tools THROUGH the gated registrar when the host exposes it', async () => {
  resetGlobals();
  captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;

  const raw = globalThis.__ccpRawTools;
  raw.push({ name: 'Bash', call: async () => [] }, { name: 'Read', call: async () => [] });

  // Install a nonce-gated registrar/unregistrar over the live array, recording
  // which names flow through each gated call.
  const NONCE = 'N1';
  const unregistered = [];
  const registered = [];
  globalThis.__ccpGetDispatchNonce = () => NONCE;
  globalThis.__ccpRegisterTool = (n, toolObj) => {
    if (n !== NONCE) throw new Error('bad nonce');
    registered.push(toolObj.name);
    if (!raw.some((t) => t && t.name === toolObj.name)) raw.push(toolObj);
    return true;
  };
  globalThis.__ccpUnregisterTool = (n, name) => {
    if (n !== NONCE) throw new Error('bad nonce');
    unregistered.push(name);
    const i = raw.findIndex((t) => t && t.name === name);
    if (i < 0) return false;
    raw.splice(i, 1);
    return true;
  };

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'reader', systemPrompt: 'READER', tools: ['Read'] });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  try {
    await define({ target: 'reader', mode: 'swap' }).execute({ task: 'go' });
    assert.ok(unregistered.includes('Bash'), 'tool hide routed through __ccpUnregisterTool (not a raw splice)');
    assert.ok(!raw.some((t) => t.name === 'Bash'), 'Bash hidden from the live surface');

    assert.equal(restoreSystemPromptIn(scope), true, 'revert succeeds');
    assert.ok(registered.includes('Bash'), 'tool restore routed through __ccpRegisterTool');
    assert.ok(raw.some((t) => t.name === 'Bash'), 'Bash restored to the live surface');
  } finally {
    delete globalThis.__ccpGetDispatchNonce;
    delete globalThis.__ccpRegisterTool;
    delete globalThis.__ccpUnregisterTool;
  }
});

// FIX (handoff #2): a restore whose live tool surface vanished must make the
// desync OBSERVABLE (bus event) rather than silently stranding the hidden tools.
test('restore emits handoff.tools.restore.skipped when the live array vanished', async () => {
  resetGlobals();
  const events = captureBus();
  globalThis.__ccpSystemPromptOverride = 'BASE';
  globalThis.__ccpSetSystemPrompt = (s) => { globalThis.__ccpSystemPromptOverride = s; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
  globalThis.__ccpRawTools.push({ name: 'Bash', call: async () => [] });

  const reg = createAgentScope();
  defineAgentIn(reg, { name: 'reader', systemPrompt: 'READER', tools: ['Read'] });
  const scope = createHandoffScope();
  const define = createDefineHandoff({ scope, getAgent: (n) => getAgentIn(reg, n), defineTool });

  await define({ target: 'reader', mode: 'swap' }).execute({ task: 'go' });
  assert.ok(!globalThis.__ccpRawTools.some((t) => t.name === 'Bash'), 'Bash hidden by swap');

  // The live surface disappears before revert (e.g. host teardown).
  delete globalThis.__ccpRawTools;
  assert.equal(restoreSystemPromptIn(scope), true, 'persona still restored despite missing array');

  const skipped = payloadOf(events, 'handoff.tools.restore.skipped');
  assert.ok(skipped, 'emitted handoff.tools.restore.skipped');
  assert.ok(skipped.names.includes('Bash'), 'event names the stranded tool');
});

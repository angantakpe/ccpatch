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

import { defineAgent, getAgent, listAgents } from '../packages/adk/agent.mjs';
import { createAgentScope, defineAgentIn, getAgentIn } from '../packages/adk/agent.mjs';
import { defineTool } from '../packages/adk/tool-registry.mjs';
import {
  defineHandoff,
  AgentRouter,
  createDefineHandoff,
  createHandoffScope,
  restoreSystemPromptIn,
  swapDepthIn,
  currentPersona,
} from '../packages/adk/handoff.mjs';
import expose from '../extensions/expose_system_prompt.mjs';

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

// ── FINDING 4: nonce-gated swap writer (handoff side) ─────────────────────────

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

// ── FINDING 1: cross-instance swap isolation over ONE global slot ─────────────

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

// ── FINDING 5: TOCTOU pin — persona changed after definition is refused ────────

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
  // Defined BEFORE the agent exists → nothing to pin.
  const handle = define({ target: 'later', mode: 'swap' });
  // Agent appears afterward.
  defineAgentIn(reg, { name: 'later', systemPrompt: 'LATE PERSONA' });

  const res = await handle.execute({ task: 'x' });
  assert.match(res, /persona swapped/i);
  assert.equal(globalThis.__ccpSystemPromptOverride, 'LATE PERSONA');
  assert.ok(topics(events).includes('handoff.pin.deferred'), 'emits handoff.pin.deferred');
});

// ── FINDING 3: AgentRouter announces code-driven control on first submit ───────

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

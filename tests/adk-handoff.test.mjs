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
import { defineTool } from '../packages/adk/tool-registry.mjs';
import { defineHandoff, AgentRouter } from '../packages/adk/handoff.mjs';
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
  sandbox.__ccpSetSystemPrompt('PERSONA');

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
  sandbox.__ccpSetSystemPrompt(null);
  assert.equal(sandbox.__ccpApplySystemPromptOverride([]).length, 0);
});

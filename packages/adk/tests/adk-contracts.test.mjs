/**
 * adk-contracts.test.mjs — ADK ↔ __ccp* contract-registry compatibility.
 *
 * This is the CI signal for ADK↔contracts drift. It runs the ADK against the
 * REAL registry implementation (core/contracts.mjs `preloadCode`, evaluated
 * exactly as the preload would), not a hand-rolled stub, and asserts:
 *
 *   1. BOOT — with every contract the ADK consumes registered at the CURRENT
 *      producer versions/shapes, capabilities() reports everything live (no
 *      downgrades), checkContract() positively validates each pin through
 *      __ccpRequire, and a tool actually injects.
 *   2. STALE — a registered-but-stale contract is refused LOUDLY: the
 *      capability is downgraded with a reason naming WHICH contract failed and
 *      the producer-vs-required version/shape mismatch; the gated injection
 *      path refuses; the persona write site throws.
 *   3. MISSING — an unregistered contract keeps the documented fail-open
 *      behavior (direct probe wins), while __ccpRequire itself still refuses
 *      loudly with an actionable error naming the contract.
 *   4. PIN PARITY — the minVersion/shape pins in packages/adk/contracts.mjs
 *      match what the in-repo producer patches actually __ccpProvide. A
 *      producer bumping a contract without the ADK following (or vice versa)
 *      fails HERE, in CI, instead of silently at runtime.
 *
 * Plain ESM, no patched CLI, no network. Runnable under `node --test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { capabilities, useAgentBus } from '../index.mjs';
import { ADK_CONTRACT_REQUIREMENTS, checkContract } from '../contracts.mjs';
import {
  defineToolIn, createToolScope, listToolsIn, toolStatusesIn,
  defineTool, __resetDriftGuardForTests,
} from '../tool-registry.mjs';
import {
  createHandoffScope, createDefineHandoff, __resetSystemPromptDriftGuardForTests,
} from '../handoff.mjs';
import { createAgentScope, defineAgentIn, getAgentIn } from '../agent.mjs';

import contractsPatch from '../../../core/contracts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

// ── global hygiene ────────────────────────────────────────────────────────────

const CCP_KEYS = [
  // registry (installed by core/contracts.mjs preload)
  '__ccpRegistry', '__ccpProvide', '__ccpRequire', '__ccpInspectContracts',
  '__ccpAdkContract',
  // primitives the ADK probes
  '__ccpRawTools', '__ccpAgentTool', '__ccpSetSystemPrompt',
  '__ccpGetSystemPrompt', '__ccpGetSystemPromptNonce',
  '__ccpSystemPromptOverride', '__ccpSubmitInput', '__ccpBus',
  '__ccpRegisterTool', '__ccpUnregisterTool', '__ccpGetDispatchNonce',
];

/** Snapshot + clear every __ccp* global this file touches; returns a restorer. */
function isolateGlobals() {
  const saved = {};
  for (const k of CCP_KEYS) saved[k] = globalThis[k];
  for (const k of CCP_KEYS) delete globalThis[k];
  __resetDriftGuardForTests();
  __resetSystemPromptDriftGuardForTests();
  return () => {
    for (const k of CCP_KEYS) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
    __resetDriftGuardForTests();
    __resetSystemPromptDriftGuardForTests();
  };
}

/**
 * Install the REAL contract registry exactly as the core/contracts.mjs preload
 * would: evaluate its `preloadCode` hook (self-bootstrapping, idempotent).
 */
function installRealRegistry() {
  assert.equal(typeof contractsPatch.preloadCode, 'string',
    'core/contracts.mjs exports preloadCode (the registry hook)');
  new Function(contractsPatch.preloadCode)();
  assert.equal(typeof globalThis.__ccpProvide, 'function', '__ccpProvide installed');
  assert.equal(typeof globalThis.__ccpRequire, 'function', '__ccpRequire installed');
  assert.equal(typeof globalThis.__ccpInspectContracts, 'function', '__ccpInspectContracts installed');
}

/**
 * Register every contract the ADK consumes at the CURRENT producer
 * versions/shapes (mirrors extensions/expose_*.mjs + event_bus), with values
 * that satisfy the shape probes, and set the matching bare globals.
 */
function provideCurrentContracts() {
  globalThis.__ccpRawTools = [];
  globalThis.__ccpAgentTool = { _capture: () => {}, invoke: async () => ({}) };
  globalThis.__ccpSetSystemPrompt = (v) => { globalThis.__ccpSystemPromptOverride = v; };
  globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
  globalThis.__ccpSubmitInput = async () => {};
  globalThis.__ccpBus = { on: () => () => {}, emit: () => {}, topics: () => [] };

  globalThis.__ccpProvide('toolDispatch', {
    version: 2,
    producer: 'expose_tool_dispatch',
    shape: ['getTools', 'invokeTool', 'buildToolContext', 'mcpHealth', 'getDispatchNonce', 'registerTool', 'unregisterTool'],
    value: {
      getTools: () => [], invokeTool: () => {}, buildToolContext: () => ({}),
      mcpHealth: () => ({}), getDispatchNonce: () => 'N',
      registerTool: () => true, unregisterTool: () => true,
    },
  });
  globalThis.__ccpProvide('agentTool', {
    version: 1,
    producer: 'expose_agent_tool',
    shape: ['_capture', 'invoke'],
    value: globalThis.__ccpAgentTool,
  });
  globalThis.__ccpProvide('systemPrompt', {
    version: 2,
    producer: 'expose_system_prompt',
    shape: ['set', 'get', 'getNonce'],
    value: {
      set: globalThis.__ccpSetSystemPrompt,
      get: globalThis.__ccpGetSystemPrompt,
      getNonce: () => 'SP-NONCE',
    },
  });
  globalThis.__ccpProvide('submitInput', {
    version: 1,
    producer: 'expose_submit_input',
    shape: [],
    value: globalThis.__ccpSubmitInput,
  });
  globalThis.__ccpProvide('bus', {
    version: 1,
    producer: 'event_bus',
    shape: ['on', 'emit', 'topics'],
    value: globalThis.__ccpBus,
  });
}

// ── 1. boot against current contract versions ─────────────────────────────────

test('ADK boots against the current contract versions: all capabilities live, every pin validates via __ccpRequire', () => {
  const restore = isolateGlobals();
  try {
    installRealRegistry();
    provideCurrentContracts();

    const caps = capabilities();
    for (const cap of ['tools', 'delegate', 'swap', 'router', 'bus']) {
      assert.equal(caps[cap], true, `capability "${cap}" is live`);
      assert.equal(caps.detail[cap].reason, undefined, `no downgrade reason on "${cap}"`);
    }
    // detail names the pinning contract for every contracted capability.
    assert.equal(caps.detail.tools.contract, 'toolDispatch');
    assert.equal(caps.detail.delegate.contract, 'agentTool');
    assert.equal(caps.detail.swap.contract, 'systemPrompt');
    assert.equal(caps.detail.router.contract, 'submitInput');
    assert.equal(caps.detail.bus.contract, 'bus');

    // Every pin positively validates through the REAL __ccpRequire (value probing).
    for (const name of Object.keys(ADK_CONTRACT_REQUIREMENTS)) {
      const res = checkContract(name);
      assert.equal(res.status, 'ok', `contract "${name}" validates: ${res.reason ?? ''}`);
      assert.equal(res.via, 'require', `contract "${name}" was probed through __ccpRequire`);
    }

    // The bus passes its drift gate.
    assert.equal(useAgentBus(), globalThis.__ccpBus);

    // And a tool actually injects (gated drift guard trusts the validated host).
    const scope = createToolScope();
    defineToolIn(scope, { name: 'boot-probe', inputSchema: { type: 'object' }, execute: async () => 'ok' });
    assert.deepEqual(listToolsIn(scope), ['boot-probe'], 'tool injected live');
  } finally {
    restore();
  }
});

// ── 2. stale contracts are refused loudly ─────────────────────────────────────

test('a STALE systemPrompt contract downgrades swap with a reason naming the contract and version gap', () => {
  const restore = isolateGlobals();
  try {
    installRealRegistry();
    globalThis.__ccpSetSystemPrompt = () => {};
    // Old producer: v1, advertises getNonce so the VERSION pin is what fails.
    globalThis.__ccpProvide('systemPrompt', {
      version: 1, producer: 'expose_system_prompt',
      shape: ['set', 'get', 'getNonce'],
      value: { set: () => {}, get: () => null, getNonce: () => 'N' },
    });

    const caps = capabilities();
    assert.equal(caps.swap, false, 'stale systemPrompt downgrades swap');
    assert.match(caps.detail.swap.reason, /systemPrompt/, 'reason names the contract');
    assert.match(caps.detail.swap.reason, /v1 < required v2/, 'reason names the version mismatch');

    const res = checkContract('systemPrompt');
    assert.equal(res.status, 'drift');
    assert.match(res.reason, /systemPrompt/);
    assert.match(res.reason, /v1 < required v2/);
  } finally {
    restore();
  }
});

test('a STALE systemPrompt contract refuses the persona WRITE loudly (handoff swap)', async () => {
  const restore = isolateGlobals();
  try {
    installRealRegistry();
    globalThis.__ccpRawTools = []; // transfer tool can inject
    globalThis.__ccpSystemPromptOverride = undefined;
    globalThis.__ccpSetSystemPrompt = (v) => { globalThis.__ccpSystemPromptOverride = v; };
    globalThis.__ccpGetSystemPrompt = () => globalThis.__ccpSystemPromptOverride ?? null;
    // Realistic old producer: v1 with NO nonce gate advertised.
    globalThis.__ccpProvide('systemPrompt', {
      version: 1, producer: 'expose_system_prompt',
      shape: ['set', 'get'],
      value: { set: globalThis.__ccpSetSystemPrompt, get: globalThis.__ccpGetSystemPrompt },
    });

    const reg = createAgentScope();
    defineAgentIn(reg, { name: 'stale-host', systemPrompt: 'P' });
    const define = createDefineHandoff({
      scope: createHandoffScope(),
      getAgent: (n) => getAgentIn(reg, n),
      defineTool,
    });
    const res = await define({ target: 'stale-host', mode: 'swap' }).execute({ task: 'x' });
    assert.match(res, /failed/i, 'swap reports failure, not success');
    assert.match(res, /systemPrompt/, 'failure names the contract');
    assert.match(res, /getNonce/, 'failure names the missing shape');
    assert.notEqual(globalThis.__ccpSystemPromptOverride, 'P', 'drifted write refused — slot untouched');
  } finally {
    restore();
  }
});

test('a STALE toolDispatch contract refuses gated injection and downgrades tools', () => {
  const restore = isolateGlobals();
  try {
    installRealRegistry();
    // Gated registrar present at runtime, but the registered contract is v1
    // without the nonce-gated registrar — the ADK must NOT trust the gated path.
    const raw = [];
    globalThis.__ccpRawTools = raw;
    let registrarCalled = false;
    globalThis.__ccpGetDispatchNonce = () => 'NONCE';
    globalThis.__ccpRegisterTool = () => { registrarCalled = true; return true; };
    globalThis.__ccpUnregisterTool = () => true;
    globalThis.__ccpProvide('toolDispatch', {
      version: 1, producer: 'expose_tool_dispatch',
      shape: ['getTools', 'invokeTool'],
      value: { getTools: () => [], invokeTool: () => {} },
    });

    const caps = capabilities();
    assert.equal(caps.tools, false, 'stale toolDispatch downgrades tools');
    assert.match(caps.detail.tools.reason, /toolDispatch/, 'reason names the contract');
    assert.match(caps.detail.tools.reason, /registerTool/, 'reason names the missing shape');

    const scope = createToolScope();
    const h = defineToolIn(scope, { name: 'stale-tool', inputSchema: { type: 'object' }, execute: async () => 'x' });
    assert.equal(registrarCalled, false, 'drifted gated registrar was NOT called');
    assert.equal(raw.some((t) => t.name === 'stale-tool'), false, 'tool not in the live array');
    assert.deepEqual(listToolsIn(scope), [], 'refused tool is not live');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'stale-tool')?.status, 'queued');
    h.dispose();
  } finally {
    restore();
  }
});

test('a STALE bus contract makes useAgentBus refuse loudly', () => {
  const restore = isolateGlobals();
  try {
    installRealRegistry();
    globalThis.__ccpBus = { on: () => {} }; // present but no emit
    globalThis.__ccpProvide('bus', {
      version: 1, producer: 'event_bus',
      shape: ['on'],
      value: globalThis.__ccpBus,
    });
    assert.throws(
      () => useAgentBus(),
      (err) => /bus/.test(err.message) && /emit/.test(err.message),
      'useAgentBus names the contract and the missing shape',
    );
  } finally {
    restore();
  }
});

// ── 3. missing contracts: fail-open at the boundary, loud at __ccpRequire ─────

test('a MISSING contract keeps the documented fail-open probe, while __ccpRequire refuses loudly', () => {
  const restore = isolateGlobals();
  try {
    installRealRegistry(); // registry live, NOTHING provided
    globalThis.__ccpRawTools = [];
    globalThis.__ccpSetSystemPrompt = () => {};

    // Opt-in boundaries: unregistered contract → direct probe wins (bare-global
    // hosts and test stubs keep working).
    const caps = capabilities();
    assert.equal(caps.tools, true, 'unregistered toolDispatch → probe wins');
    assert.equal(caps.swap, true, 'unregistered systemPrompt → probe wins');
    assert.equal(checkContract('toolDispatch').status, 'unchecked');
    assert.equal(checkContract('systemPrompt').status, 'unchecked');

    // The registry itself is the loud layer: requiring an unregistered contract
    // is an actionable error naming the contract.
    assert.throws(
      () => globalThis.__ccpRequire('systemPrompt', { consumer: 'adk:handoff', minVersion: 2, shape: ['getNonce'] }),
      /requires contract "systemPrompt" but no producer has registered it/,
    );
  } finally {
    restore();
  }
});

// ── 4. pin parity with the in-repo producers ──────────────────────────────────

/**
 * Parse a producer file for its __ccpProvide('<name>', {...}) registration and
 * extract the advertised version + shape. The provide call may live inside an
 * injected-code string (expose_tool_dispatch) or plain module code (event_bus),
 * so this works on raw file text.
 */
function parseProducerRegistration(file, name) {
  const src = readFileSync(file, 'utf8');
  const at = src.search(new RegExp(`__ccpProvide\\(\\s*['"]${name}['"]`));
  assert.notEqual(at, -1, `${file} registers contract "${name}" via __ccpProvide`);
  const window = src.slice(at, at + 1200);
  const vm = window.match(/version:\s*(\d+)/);
  assert.ok(vm, `producer registration for "${name}" advertises a numeric version`);
  const sm = window.match(/shape:\s*\[([^\]]*)\]/);
  assert.ok(sm, `producer registration for "${name}" advertises a shape array`);
  const shape = [...sm[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return { version: Number(vm[1]), shape };
}

test('ADK contract pins match the in-repo producer registrations (drift fails CI here)', () => {
  for (const [name, req] of Object.entries(ADK_CONTRACT_REQUIREMENTS)) {
    const producerFile = resolve(REPO_ROOT, 'extensions', `${req.producerPatch}.mjs`);
    const { version, shape } = parseProducerRegistration(producerFile, name);

    assert.ok(
      version >= req.minVersion,
      `contract "${name}": producer ${req.producerPatch} provides v${version} but the ADK pins ` +
      `minVersion ${req.minVersion} (packages/adk/contracts.mjs) — producer regressed or pin is wrong`,
    );
    for (const key of req.shape) {
      assert.ok(
        shape.includes(key),
        `contract "${name}": ADK requires shape "${key}" but producer ${req.producerPatch} ` +
        `advertises [${shape.join(', ')}] — update the producer or the pin in packages/adk/contracts.mjs`,
      );
    }
  }
});

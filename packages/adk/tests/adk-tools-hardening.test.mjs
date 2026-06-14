/**
 * adk-tools-hardening.test.mjs
 *
 * Coverage for the HARDENED tool-registry surface:
 *   - nonce-gated injection: defineTool routes through __ccpRegisterTool /
 *     __ccpUnregisterTool with the dispatch nonce; a wrong nonce throws.
 *   - fallback path: a bare `__ccpRawTools = []` (no registrar) still injects.
 *   - strengthened validateInput: additionalProperties:false, enum, maxLength,
 *     plus the MAX_INPUT_BYTES ceiling enforced at the call() boundary.
 *   - onInjectFail fires on poll timeout; throwOnInjectFail rejects .injected.
 *   - listTools()/listToolsIn() reflect injected + disposed state.
 *
 * Plain ESM, no patched CLI, no network. Real timers; the timeout test relies on
 * the bounded poll ceiling, never wall-clock 5s.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defineToolIn,
  createToolScope,
  createToolRegistry,
  validateInput,
  listToolsIn,
  toolStatusesIn,
  disposeToolScope,
  __resetDriftGuardForTests,
  __resetSchemaWarnDedupeForTests,
} from '../tool-registry.mjs';

// ── shared global hygiene ─────────────────────────────────────────────────────

/** Snapshot + clear every __ccp* global these tests poke at; returns a restorer. */
function isolateGlobals() {
  const keys = [
    '__ccpRawTools', '__ccpGetDispatchNonce', '__ccpRegisterTool',
    '__ccpUnregisterTool', '__ccpBus',
    '__ccpRequire', '__ccpInspectContracts', '__ccpDebug',
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

/** Install a stub nonce + gated registrar over a backing array. Returns the array. */
function installGatedRegistrar(nonce = 'NONCE-XYZ') {
  const raw = [];
  globalThis.__ccpRawTools = raw;
  globalThis.__ccpGetDispatchNonce = () => nonce;
  globalThis.__ccpRegisterTool = (callerNonce, toolObj) => {
    if (callerNonce !== nonce) {
      throw new Error('__ccpRegisterTool: invalid nonce. Call __ccpGetDispatchNonce() at startup.');
    }
    const i = raw.findIndex((t) => t && t.name === toolObj.name);
    if (i >= 0) raw[i] = toolObj; else raw.push(toolObj);
    return true;
  };
  globalThis.__ccpUnregisterTool = (callerNonce, name) => {
    if (callerNonce !== nonce) {
      throw new Error('__ccpUnregisterTool: invalid nonce. Call __ccpGetDispatchNonce() at startup.');
    }
    const i = raw.findIndex((t) => t && t.name === name);
    if (i < 0) return false;
    raw.splice(i, 1);
    return true;
  };
  return raw;
}

// ── nonce-gated injection path ────────────────────────────────────────────────

test('defineTool routes injection through the gated registrar with the dispatch nonce', () => {
  const restore = isolateGlobals();
  try {
    const seen = [];
    const raw = [];
    globalThis.__ccpRawTools = raw;
    globalThis.__ccpGetDispatchNonce = () => 'GOOD';
    globalThis.__ccpRegisterTool = (callerNonce, toolObj) => {
      seen.push(callerNonce);
      raw.push(toolObj);
      return true;
    };

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'gated', inputSchema: { type: 'object' }, execute: async () => 'ok',
    });
    assert.deepEqual(seen, ['GOOD'], 'registrar called once with the dispatch nonce');
    assert.ok(raw.some((t) => t.name === 'gated'), 'tool landed via registrar');
    // dispose() routes through the gated unregistrar.
    globalThis.__ccpUnregisterTool = (callerNonce, name) => {
      assert.equal(callerNonce, 'GOOD', 'unregister also passes the nonce');
      const i = raw.findIndex((t) => t && t.name === name);
      if (i < 0) return false; raw.splice(i, 1); return true;
    };
    assert.equal(h.dispose(), true, 'gated unregister removes the tool');
    assert.equal(raw.some((t) => t.name === 'gated'), false);
  } finally {
    restore();
  }
});

test('a wrong dispatch nonce makes the gated registrar throw', () => {
  const restore = isolateGlobals();
  try {
    installGatedRegistrar('REAL');
    // Hand the registry the WRONG nonce.
    globalThis.__ccpGetDispatchNonce = () => 'WRONG';
    const scope = createToolScope();
    assert.throws(
      () => defineToolIn(scope, { name: 'bad', inputSchema: { type: 'object' }, execute: async () => 'x' }),
      /invalid nonce\. Call __ccpGetDispatchNonce\(\) at startup\./,
    );
  } finally {
    restore();
  }
});

// ── fallback (bare-array) path stays backward compatible ──────────────────────

test('with only a bare __ccpRawTools (no registrar), tools still inject', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = []; // NO __ccpRegisterTool present
    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'fallback', inputSchema: { type: 'object' }, execute: async () => 'ok',
    });
    assert.ok(globalThis.__ccpRawTools.some((t) => t.name === 'fallback'),
      'direct-array fallback injected the tool');
    assert.equal(h.dispose(), true, 'fallback splice removes it');
    assert.equal(globalThis.__ccpRawTools.some((t) => t.name === 'fallback'), false);
  } finally {
    restore();
  }
});

// ── strengthened validateInput + size ceiling ─────────────────────────────────

test('validateInput: additionalProperties:false rejects unknown keys', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: false,
  };
  assert.equal(validateInput(schema, { a: 'x' }), null, 'declared key ok');
  assert.match(validateInput(schema, { a: 'x', b: 1 }), /unexpected property "b"/);
});

test('validateInput: enum rejects values not in the set', () => {
  const schema = {
    type: 'object',
    properties: { color: { type: 'string', enum: ['red', 'green'] } },
  };
  assert.equal(validateInput(schema, { color: 'red' }), null);
  assert.match(validateInput(schema, { color: 'blue' }), /must be one of: "red", "green"/);
});

test('validateInput: minLength/maxLength enforced for strings', () => {
  const schema = {
    type: 'object',
    properties: { s: { type: 'string', minLength: 2, maxLength: 4 } },
  };
  assert.equal(validateInput(schema, { s: 'abc' }), null);
  assert.match(validateInput(schema, { s: 'a' }), /at least 2 characters/);
  assert.match(validateInput(schema, { s: 'abcde' }), /at most 4 characters/);
});

test('tool call() rejects oversized input BEFORE execute() runs', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    let ran = false;
    defineToolIn(scope, {
      name: 'sized',
      inputSchema: { type: 'object' },
      execute: async () => { ran = true; return 'should not run'; },
    });
    const t = globalThis.__ccpRawTools.find((x) => x.name === 'sized');

    // Build an input whose JSON.stringify exceeds the 256KiB ceiling.
    const huge = { blob: 'x'.repeat(300 * 1024) };
    const res = await t.call(huge);
    assert.equal(ran, false, 'execute() was NOT called for oversized input');
    assert.match(res[0].text, /input exceeds \d+ byte ceiling/);

    // A small valid input still runs.
    const ok = await t.call({ blob: 'tiny' });
    assert.equal(ran, true, 'small input runs execute()');
    assert.deepEqual(ok, [{ type: 'text', text: 'should not run' }]);
  } finally {
    restore();
  }
});

test('tool call() rejects an UNMEASURABLE (cyclic) input instead of executing it', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    let ran = false;
    defineToolIn(scope, {
      name: 'cyclic',
      inputSchema: { type: 'object' },
      execute: async () => { ran = true; return 'should not run'; },
    });
    const t = globalThis.__ccpRawTools.find((x) => x.name === 'cyclic');

    // A cyclic object — JSON.stringify throws, so inputByteSize() cannot measure
    // it. The old 0-byte fallthrough let this slip past the MAX_INPUT_BYTES
    // ceiling and reach execute(); the boundary must now REJECT it.
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const res = await t.call(cyclic);
    assert.equal(ran, false, 'execute() was NOT called for an unmeasurable cyclic input');
    assert.match(res[0].text, /could not be measured\/serialized/);

    // A payload with a throwing toJSON is likewise rejected, not run.
    const throwing = { toJSON() { throw new Error('nope'); } };
    const res2 = await t.call(throwing);
    assert.equal(ran, false, 'execute() still not called for a throwing-toJSON input');
    assert.match(res2[0].text, /could not be measured\/serialized/);

    // A normal small input still runs (the guard is surgical, not blanket).
    const ok = await t.call({ a: 1 });
    assert.equal(ran, true, 'a measurable input still executes');
    assert.deepEqual(ok, [{ type: 'text', text: 'should not run' }]);
  } finally {
    restore();
  }
});

test('tool call() enforces additionalProperties:false + enum at the boundary', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    let ran = false;
    defineToolIn(scope, {
      name: 'strict',
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['a', 'b'] } },
        additionalProperties: false,
      },
      execute: async () => { ran = true; return 'ok'; },
    });
    const t = globalThis.__ccpRawTools.find((x) => x.name === 'strict');

    const extra = await t.call({ mode: 'a', rogue: 1 });
    assert.equal(ran, false);
    assert.match(extra[0].text, /unexpected property "rogue"/);

    const badEnum = await t.call({ mode: 'z' });
    assert.equal(ran, false);
    assert.match(badEnum[0].text, /must be one of/);

    const ok = await t.call({ mode: 'b' });
    assert.equal(ran, true);
    assert.deepEqual(ok, [{ type: 'text', text: 'ok' }]);
  } finally {
    restore();
  }
});

// ── onInjectFail / throwOnInjectFail on poll timeout ──────────────────────────

test('onInjectFail fires when the bounded poll times out (no array ever)', async () => {
  const restore = isolateGlobals();
  try {
    delete globalThis.__ccpRawTools; // array never appears
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const scope = createToolScope();
      let failed = null;
      const h = defineToolIn(scope, {
        name: 'will-timeout',
        inputSchema: { type: 'object' },
        execute: async () => 'ok',
        onInjectFail: (name) => { failed = name; },
      });
      const settled = await Promise.race([
        h.ready.then((v) => ({ v })),
        new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
      ]);
      assert.deepEqual(settled, { v: false }, '.ready resolves false on timeout');
      assert.equal(failed, 'will-timeout', 'onInjectFail fired with the tool name');
      assert.equal(scope.pollHandle, null, 'poller torn down');
    } finally {
      console.warn = realWarn;
    }
  } finally {
    restore();
  }
});

test('throwOnInjectFail rejects the .injected promise on timeout (.ready still false)', async () => {
  const restore = isolateGlobals();
  try {
    delete globalThis.__ccpRawTools;
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const scope = createToolScope();
      const h = defineToolIn(scope, {
        name: 'hard-fail',
        inputSchema: { type: 'object' },
        execute: async () => 'ok',
        throwOnInjectFail: true,
      });
      const readyVal = await Promise.race([
        h.ready,
        new Promise((r) => setTimeout(() => r('hang'), 8000)),
      ]);
      assert.equal(readyVal, false, '.ready stays false (backward compatible)');

      let rejected = false;
      await h.injected.catch((e) => { rejected = true; assert.match(e.message, /never injected/); });
      assert.equal(rejected, true, '.injected rejected because throwOnInjectFail was set');
    } finally {
      console.warn = realWarn;
    }
  } finally {
    restore();
  }
});

// ── listTools introspection ───────────────────────────────────────────────────

test('listToolsIn reflects injected then disposed state', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    assert.deepEqual(listToolsIn(scope), [], 'empty scope lists nothing');

    const h1 = defineToolIn(scope, { name: 't1', inputSchema: {}, execute: async () => 'a' });
    defineToolIn(scope, { name: 't2', inputSchema: {}, execute: async () => 'b' });
    assert.deepEqual(new Set(listToolsIn(scope)), new Set(['t1', 't2']), 'both injected tools listed');

    h1.dispose();
    assert.deepEqual(listToolsIn(scope), ['t2'], 'disposed tool removed from the list');
  } finally {
    restore();
  }
});

test('createToolRegistry exposes a scope-bound listTools()', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    const reg = createToolRegistry(scope);
    reg.defineTool({ name: 'r1', inputSchema: {}, execute: async () => 'x' });
    assert.deepEqual(reg.listTools(), ['r1'], 'registry.listTools() reflects the bound scope');
  } finally {
    restore();
  }
});

// ── load-bearing drift guard refuses a drifted gated path ─────────────────────

test('a drift-refused tool stays QUEUED across poll ticks then recovers when the contract heals (non-latching, finding #1)', async () => {
  // REWRITTEN (finding #1): the old test asserted 'queued' ONLY synchronously,
  // before any poll tick — so it could not distinguish the BROKEN sticky-latch
  // behavior (refused → instantly 'failed' within ~50ms, poller torn down,
  // recovery impossible) from the INTENDED non-latching design (refused → stays
  // queued, bounded poll keeps retrying, a RECOVERED host injects on a later
  // tick). This version makes the intent real: it lets several real poll ticks
  // pass with the tool still QUEUED, then heals the contract and asserts the tool
  // actually injects — only possible if drift does NOT latch and the poller lives.
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    let drifted = true; // flipped to heal the contract mid-test.
    globalThis.__ccpInspectContracts = () => [
      drifted
        ? { name: 'toolDispatch', version: 1, shape: ['somethingElse'] }
        : { name: 'toolDispatch', version: 2, shape: ['registerTool'] },
    ];
    globalThis.__ccpRequire = (name, opts) => {
      assert.equal(name, 'toolDispatch');
      assert.equal(opts.consumer, 'adk:tools');
      assert.deepEqual(opts.shape, ['registerTool']);
      if (drifted) throw new Error('contract "toolDispatch" missing required path "registerTool"');
      return globalThis.__ccpRegisterTool; // healed: a valid value
    };

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'drifted', inputSchema: { type: 'object' }, execute: async () => 'x',
    });
    // Refused synchronously: the drifted global was NOT called, not live, queued.
    assert.equal(raw.some((t) => t.name === 'drifted'), false, 'drifted registrar was NOT called');
    assert.deepEqual(listToolsIn(scope), [], 'refused tool is not reported live');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'drifted')?.status, 'queued');

    // Let SEVERAL real 50ms poll ticks elapse — under the broken sticky latch the
    // tool would already be 'failed' and the poller gone. It must still be queued.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'drifted')?.status, 'queued',
      'a drift-refused tool stays queued across poll ticks (NOT latched to failed)');
    assert.equal(raw.some((t) => t.name === 'drifted'), false, 'still not injected while drifted');

    // Heal the contract; the still-alive non-latching poller must inject it.
    __resetDriftGuardForTests();
    drifted = false;
    const settled = await Promise.race([
      h.ready.then((v) => ({ v })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    assert.deepEqual(settled, { v: true }, 'recovered contract → poller injects → ready=true');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'drifted')?.status, 'live',
      'tool went live after the contract recovered (proves drift did not latch)');
    assert.ok(raw.some((t) => t.name === 'drifted'), 'tool landed once the contract healed');
    h.dispose();
  } finally {
    restore();
    __resetDriftGuardForTests();
  }
});

test('a PERMANENTLY drifted contract settles the tool to failed at the bounded poll limit (finding #1, ~5s)', async () => {
  // The flip side of recovery: if the host never heals, the non-latching poll must
  // still bound out at ~5s and settle the tool 'failed' — it must not spin forever.
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    globalThis.__ccpInspectContracts = () => [{ name: 'toolDispatch', version: 1, shape: ['somethingElse'] }];
    globalThis.__ccpRequire = () => { throw new Error('contract "toolDispatch" missing required path "registerTool"'); };

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'perma-drift', inputSchema: { type: 'object' }, execute: async () => 'x',
    });
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'perma-drift')?.status, 'queued');

    const settled = await Promise.race([
      h.ready.then((v) => ({ v })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    assert.deepEqual(settled, { v: false }, 'bounded poll settles ready=false — never spins forever');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'perma-drift')?.status, 'failed',
      'permanently-drifted tool eventually settles to failed');
    assert.equal(raw.some((t) => t.name === 'perma-drift'), false, 'never injected through the drifted path');
    assert.equal(scope.pollHandle, null, 'poller torn down after the bounded limit');
  } finally {
    console.warn = realWarn;
    restore();
    __resetDriftGuardForTests();
  }
});

test('an UNREGISTERED toolDispatch contract leaves the gated path alone (fail-open)', () => {
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    // __ccpRequire present, but NO 'toolDispatch' contract registered → fail open.
    globalThis.__ccpInspectContracts = () => [{ name: 'somethingUnrelated' }];
    globalThis.__ccpRequire = () => { throw new Error('should not be consulted'); };

    const scope = createToolScope();
    defineToolIn(scope, {
      name: 'open', inputSchema: { type: 'object' }, execute: async () => 'x',
    });
    assert.ok(raw.some((t) => t.name === 'open'), 'fail-open: tool injected via gated registrar');
    assert.deepEqual(listToolsIn(scope), ['open']);
  } finally {
    restore();
    __resetDriftGuardForTests();
  }
});

// ── schema foot-gun: warn at definition for keywords validateInput won't enforce ─

test('defineTool warns (debug) when inputSchema has keywords validateInput ignores, and not when a validate hook is given', () => {
  const restore = isolateGlobals();
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  globalThis.__ccpDebug = true; // route debug() to console.warn
  globalThis.__ccpRawTools = []; // live array → tools inject (no "queued" debug noise)
  // The schema-warning is the only debug line containing this phrase.
  const schemaWarn = (toolName) => warnings.find((w) => w.includes(`tool "${toolName}"`) && w.includes('does NOT enforce'));
  try {
    const scope = createToolScope();

    // Schema with deep keywords the built-in cannot enforce.
    defineToolIn(scope, {
      name: 'deep',
      inputSchema: {
        type: 'object',
        properties: {
          age: { type: 'number', minimum: 0, maximum: 120 },
          name: { type: 'string', pattern: '^[a-z]+$' },
          nested: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
      execute: async () => 'x',
    });
    const msg = schemaWarn('deep');
    assert.ok(msg, 'a warning was emitted for the un-enforced schema');
    assert.ok(msg.includes('properties.age.minimum'), 'names the numeric bound');
    assert.ok(msg.includes('properties.name.pattern'), 'names the pattern');
    assert.ok(msg.includes('nested object not recursed'), 'names the nested shape');

    // A pluggable validate hook suppresses the warning (the documented escape hatch).
    defineToolIn(scope, {
      name: 'guarded',
      inputSchema: { type: 'object', properties: { age: { type: 'number', minimum: 0 } } },
      validate: () => null,
      execute: async () => 'x',
    });
    assert.equal(schemaWarn('guarded'), undefined, 'no warning when validate hook present');

    // A schema with only enforced keywords does not warn.
    defineToolIn(scope, {
      name: 'shallow',
      inputSchema: { type: 'object', properties: { s: { type: 'string', minLength: 1 } }, required: ['s'], additionalProperties: false },
      execute: async () => 'x',
    });
    assert.equal(schemaWarn('shallow'), undefined, 'no warning for an all-enforced schema');
  } finally {
    console.warn = realWarn;
    restore();
  }
});

test('a fail-open inject does NOT latch — a later-registered drifted contract is still caught', () => {
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    // FIRST inject: helpers present but NO 'toolDispatch' contract yet → fail open.
    // The old guard latched _driftOk=true here, blinding it to later drift.
    globalThis.__ccpInspectContracts = () => [];
    globalThis.__ccpRequire = () => { throw new Error('should not be consulted while unregistered'); };
    const scope = createToolScope();
    defineToolIn(scope, { name: 'early', inputSchema: { type: 'object' }, execute: async () => 'x' });
    assert.ok(raw.some((t) => t.name === 'early'), 'fail-open while contract unregistered');

    // The contract registry populates LATER and the registrar is now drifted.
    globalThis.__ccpInspectContracts = () => [{ name: 'toolDispatch', version: 1, shape: ['somethingElse'] }];
    globalThis.__ccpRequire = () => { throw new Error('contract "toolDispatch" missing required path "registerTool"'); };

    // A SECOND inject must re-evaluate (not reuse the fail-open latch) and refuse.
    const h = defineToolIn(scope, { name: 'late', inputSchema: { type: 'object' }, execute: async () => 'x' });
    assert.equal(raw.some((t) => t.name === 'late'), false, 'drifted contract caught on the later inject');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'late')?.status, 'queued', 'refused tool not live');
    h.dispose();
  } finally {
    restore();
    __resetDriftGuardForTests();
  }
});

// ── exercise the GATED nonce path end-to-end (inject + dispose) ───────────────

test('gated nonce-shaped registrar path: inject then dispose end-to-end', () => {
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    const scope = createToolScope();

    const h = defineToolIn(scope, {
      name: 'gated-e2e', inputSchema: { type: 'object' }, execute: async () => 'ok',
    });
    assert.ok(raw.some((t) => t.name === 'gated-e2e'), 'inject landed via the nonce-gated registrar');
    assert.deepEqual(listToolsIn(scope), ['gated-e2e'], 'reported live after gated inject');
    assert.equal(toolStatusesIn(scope)[0].status, 'live');

    // dispose() must route through the nonce-gated __ccpUnregisterTool.
    assert.equal(h.dispose(), true, 'gated unregister removed the tool');
    assert.equal(raw.some((t) => t.name === 'gated-e2e'), false, 'tool gone from backing array');
    assert.deepEqual(listToolsIn(scope), [], 'no longer reported live after dispose');
  } finally {
    restore();
    __resetDriftGuardForTests();
  }
});

// ── queued-then-timed-out is NOT live and shows status 'failed' ───────────────

test('a queued-then-timed-out tool is not reported live and shows status failed', async () => {
  const restore = isolateGlobals();
  try {
    delete globalThis.__ccpRawTools; // registry never appears
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const scope = createToolScope();
      const h = defineToolIn(scope, {
        name: 'queued-fail', inputSchema: { type: 'object' }, execute: async () => 'ok',
      });
      // While queued: NOT live, status 'queued'.
      assert.deepEqual(listToolsIn(scope), [], 'queued tool is not reported live');
      assert.equal(toolStatusesIn(scope).find((s) => s.name === 'queued-fail')?.status, 'queued');

      const settled = await Promise.race([
        h.ready.then((v) => ({ v })),
        new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
      ]);
      assert.deepEqual(settled, { v: false }, '.ready resolved false on poll timeout');
      // After timeout: still NOT live, but observable with status 'failed'.
      assert.deepEqual(listToolsIn(scope), [], 'timed-out tool is NOT reported live');
      assert.equal(toolStatusesIn(scope).find((s) => s.name === 'queued-fail')?.status, 'failed',
        'timed-out tool shows status failed');
    } finally {
      console.warn = realWarn;
    }
  } finally {
    restore();
  }
});

// ── pluggable custom validator hook ───────────────────────────────────────────

test('custom validate() hook runs AFTER built-in validateInput at the call() boundary', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    let ran = false;
    const seen = [];
    defineToolIn(scope, {
      name: 'custom-validate',
      inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
      // Deep/numeric-bound check the built-in does NOT do.
      validate: (input) => { seen.push('called'); return input.n > 10 ? 'n must be <= 10' : null; },
      execute: async () => { ran = true; return 'ok'; },
    });
    const t = globalThis.__ccpRawTools.find((x) => x.name === 'custom-validate');

    // Built-in failure short-circuits FIRST — custom validator must NOT run.
    const builtinFail = await t.call({ n: 'not-a-number' });
    assert.match(builtinFail[0].text, /must be of type number/);
    assert.equal(seen.length, 0, 'custom validator did not run when built-in already failed');
    assert.equal(ran, false);

    // Built-in passes, custom validator rejects.
    const customFail = await t.call({ n: 99 });
    assert.match(customFail[0].text, /n must be <= 10/);
    assert.equal(ran, false, 'execute() not called when custom validator rejects');

    // Both pass → execute runs.
    const ok = await t.call({ n: 5 });
    assert.equal(ran, true);
    assert.deepEqual(ok, [{ type: 'text', text: 'ok' }]);
  } finally {
    restore();
  }
});

test('a throwing custom validate() is surfaced as a validation error', async () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    let ran = false;
    defineToolIn(scope, {
      name: 'throwing-validate',
      inputSchema: { type: 'object' },
      validate: () => { throw new Error('boom from validator'); },
      execute: async () => { ran = true; return 'ok'; },
    });
    const t = globalThis.__ccpRawTools.find((x) => x.name === 'throwing-validate');
    const res = await t.call({ anything: 1 });
    assert.match(res[0].text, /boom from validator/);
    assert.equal(ran, false);
  } finally {
    restore();
  }
});

// ── disposeToolScope tears everything down (idempotent) ───────────────────────

test('disposeToolScope removes live tools, resolves pending false, and is idempotent', async () => {
  const restore = isolateGlobals();
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    const scope = createToolScope();

    const live = defineToolIn(scope, {
      name: 'live-tool', inputSchema: { type: 'object' }, execute: async () => 'ok',
    });
    assert.ok(raw.some((t) => t.name === 'live-tool'), 'tool is live before dispose');

    // Now make the registry "disappear" so a second tool stays QUEUED/pending.
    delete globalThis.__ccpRegisterTool;
    delete globalThis.__ccpUnregisterTool;
    delete globalThis.__ccpRawTools;
    const realWarn = console.warn; console.warn = () => {};
    try {
      const pendingHandle = defineToolIn(scope, {
        name: 'pending-tool', inputSchema: { type: 'object' }, execute: async () => 'x',
      });
      assert.equal(toolStatusesIn(scope).find((s) => s.name === 'pending-tool')?.status, 'queued');

      // Re-expose the array so the gated removal of the live tool has a backing store.
      globalThis.__ccpRawTools = raw;
      disposeToolScope(scope);

      // Pending .ready resolves false (no hang) — verify within a tick.
      const v = await Promise.race([
        pendingHandle.ready,
        new Promise((r) => setTimeout(() => r('HANG'), 1000)),
      ]);
      assert.equal(v, false, 'pending .ready resolved false on dispose');
      assert.equal(raw.some((t) => t.name === 'live-tool'), false, 'live tool removed from registry');
      assert.deepEqual(listToolsIn(scope), [], 'scope reports nothing live after dispose');
      assert.deepEqual(toolStatusesIn(scope), [], 'status map cleared');
      assert.equal(scope.pollHandle, null, 'scheduler registration cleared');

      // Idempotent: second call is a no-op and does not throw.
      assert.doesNotThrow(() => disposeToolScope(scope));
      // unused live handle ref to satisfy lint
      void live;
    } finally {
      console.warn = realWarn;
    }
  } finally {
    restore();
  }
});

// ── finding #2: name collision must NOT clobber a pre-existing non-ADK tool ────

test('defineTool refuses to overwrite a pre-existing non-ADK tool of the same name (fallback path)', async () => {
  const restore = isolateGlobals();
  try {
    // A bare array (fallback path) ALREADY containing a "built-in" the ADK never
    // registered — e.g. the CLI's real Bash. defineTool({name:'Bash'}) must NOT
    // replace it; __ccpRawTools is the same array the CLI dispatches built-ins
    // from, so clobbering it would silently break the real tool.
    const realBash = { name: 'Bash', call: async () => [{ type: 'text', text: 'REAL BASH' }] };
    globalThis.__ccpRawTools = [realBash];

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'Bash',
      inputSchema: { type: 'object' },
      execute: async () => 'ADK IMPOSTER',
    });

    // The original built-in is untouched and the ADK tool did NOT take its slot.
    const entries = globalThis.__ccpRawTools.filter((t) => t.name === 'Bash');
    assert.equal(entries.length, 1, 'still exactly one Bash entry');
    assert.equal(entries[0], realBash, 'the pre-existing non-ADK Bash was NOT overwritten');
    // It is reported as a FAILURE, not silently live.
    assert.deepEqual(listToolsIn(scope), [], 'collided tool is not reported live');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'Bash')?.status, 'failed',
      'collision reports status failed');
    // .ready resolves false (terminal, immediate) — verify it does not hang.
    assert.equal(await h.ready, false, '.ready resolves false on a name collision');
  } finally {
    restore();
  }
});

test('a tool the ADK itself registered CAN be re-upserted (ownership) — only NON-owned names are protected', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpRawTools = [];
    const scope = createToolScope();
    // First define: ADK owns 'mine'.
    const h1 = defineToolIn(scope, { name: 'mine', inputSchema: { type: 'object' }, execute: async () => 'v1' });
    assert.deepEqual(listToolsIn(scope), ['mine']);
    // Re-define the SAME owned name → allowed upsert (not a collision).
    const h2 = defineToolIn(scope, { name: 'mine', inputSchema: { type: 'object' }, execute: async () => 'v2' });
    assert.equal(globalThis.__ccpRawTools.filter((t) => t.name === 'mine').length, 1, 'still one entry, upserted');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'mine')?.status, 'live', 'owned re-upsert stays live');
    void h1; void h2;
  } finally {
    restore();
  }
});

// ── finding #3: schema foot-gun warning fires UNCONDITIONALLY (no CLAUDE_DEBUG) ─

test('the schema foot-gun warning fires WITHOUT CLAUDE_DEBUG / __ccpDebug, once per tool (finding #3)', () => {
  const restore = isolateGlobals();
  __resetSchemaWarnDedupeForTests();
  const realWarn = console.warn;
  const savedEnv = process.env.CLAUDE_DEBUG;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    // Debug is explicitly OFF — neither the env switch nor the global is set.
    delete process.env.CLAUDE_DEBUG;
    delete globalThis.__ccpDebug;
    globalThis.__ccpRawTools = []; // live array → no "queued" noise
    const scope = createToolScope();

    const schemaWarn = (name) => warnings.filter((w) => w.includes(`tool "${name}"`) && w.includes('does NOT enforce'));

    // A schema with un-enforceable keywords and NO validate hook → must warn even
    // though debug is off (it's a one-time authoring signal, not debug noise).
    defineToolIn(scope, {
      name: 'unenforced-prod',
      inputSchema: { type: 'object', properties: { age: { type: 'number', minimum: 0 } } },
      execute: async () => 'x',
    });
    assert.equal(schemaWarn('unenforced-prod').length, 1, 'warning fired with debug OFF');
    assert.ok(schemaWarn('unenforced-prod')[0].includes('properties.age.minimum'), 'names the unenforced keyword');

    // Re-defining the SAME tool name must NOT warn again (dedupe → once per tool).
    defineToolIn(scope, {
      name: 'unenforced-prod',
      inputSchema: { type: 'object', properties: { age: { type: 'number', minimum: 0 } } },
      execute: async () => 'x',
    });
    assert.equal(schemaWarn('unenforced-prod').length, 1, 'second define of the same tool does NOT re-warn (deduped)');

    // A validate() hook still suppresses the warning entirely.
    defineToolIn(scope, {
      name: 'hooked-prod',
      inputSchema: { type: 'object', properties: { age: { type: 'number', minimum: 0 } } },
      validate: () => null,
      execute: async () => 'x',
    });
    assert.equal(schemaWarn('hooked-prod').length, 0, 'no warning when a validate hook is supplied');
  } finally {
    console.warn = realWarn;
    if (savedEnv === undefined) delete process.env.CLAUDE_DEBUG; else process.env.CLAUDE_DEBUG = savedEnv;
    __resetSchemaWarnDedupeForTests();
    restore();
  }
});

// ── finding #4: a throwing gated registrar during DRAIN must not crash ─────────

test('a throwing gated registrar during drain does NOT crash and the tool settles to failed (finding #4)', async () => {
  // The gated registrar throws on an invalid/rotated nonce. During the bounded
  // drain (driven by the shared setInterval), that throw must be caught and
  // treated as a failed-this-attempt — never escape as a process uncaughtException.
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  const realWarn = console.warn;
  console.warn = () => {};
  // Fail the test if ANY uncaught exception escapes the scheduler during the run.
  let uncaught = null;
  const onUncaught = (err) => { uncaught = err; };
  process.on('uncaughtException', onUncaught);
  try {
    // Registrar AND array ABSENT at define time → the tool QUEUES (the synchronous
    // define-time path is intentionally not the one under test here; we want the
    // throw to happen inside the shared-scheduler drain).
    delete globalThis.__ccpRawTools;
    delete globalThis.__ccpRegisterTool;
    globalThis.__ccpGetDispatchNonce = () => 'CURRENT';

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'throws-on-inject', inputSchema: { type: 'object' }, execute: async () => 'x',
    });
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'throws-on-inject')?.status, 'queued');

    // Now install a registrar that ALWAYS throws (as if the nonce rotated) AND the
    // array, so the NEXT poll tick attempts a gated drain → registrar throws on
    // every attempt → caught in drainQueue → re-queued until the bounded limit →
    // settle failed, all WITHOUT escaping the setInterval as an uncaughtException.
    setTimeout(() => {
      globalThis.__ccpRegisterTool = () => {
        throw new Error('__ccpRegisterTool: invalid nonce. Call __ccpGetDispatchNonce() at startup.');
      };
      globalThis.__ccpRawTools = [];
    }, 60);

    const settled = await Promise.race([
      h.ready.then((v) => ({ v })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    assert.deepEqual(settled, { v: false }, 'throwing registrar → bounded poll settles ready=false');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'throws-on-inject')?.status, 'failed',
      'tool settled to failed without crashing');
    assert.equal(scope.pollHandle, null, 'poller torn down after the bounded limit');
    assert.equal(uncaught, null, 'NO uncaught exception escaped the shared scheduler');
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    console.warn = realWarn;
    restore();
    __resetDriftGuardForTests();
  }
});

test('removeFromRaw via a throwing gated unregistrar returns false instead of throwing (finding #4)', () => {
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  try {
    // A working register path so the tool goes live and dispose() routes through
    // the gated unregistrar — which throws (e.g. rotated nonce).
    const raw = [];
    globalThis.__ccpRawTools = raw;
    globalThis.__ccpGetDispatchNonce = () => 'CURRENT';
    globalThis.__ccpRegisterTool = (n, toolObj) => { raw.push(toolObj); return true; };
    globalThis.__ccpUnregisterTool = () => {
      throw new Error('__ccpUnregisterTool: invalid nonce. Call __ccpGetDispatchNonce() at startup.');
    };

    const scope = createToolScope();
    const h = defineToolIn(scope, { name: 'gated-dispose-throw', inputSchema: { type: 'object' }, execute: async () => 'x' });
    assert.ok(raw.some((t) => t.name === 'gated-dispose-throw'), 'tool injected via gated registrar');

    // dispose() must NOT throw even though the unregistrar does; it returns false.
    let removed;
    assert.doesNotThrow(() => { removed = h.dispose(); }, 'dispose swallows the unregistrar throw');
    assert.equal(removed, false, 'a throwing unregistrar reports "not removed" (false)');
    // Local scope bookkeeping is still cleaned up regardless of the host throw.
    assert.deepEqual(listToolsIn(scope), [], 'scope no longer lists the tool after dispose');
  } finally {
    restore();
    __resetDriftGuardForTests();
  }
});

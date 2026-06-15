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

test('a wrong dispatch nonce does NOT throw at define time — it queues for bounded retry (consistent with the drain path)', async () => {
  const restore = isolateGlobals();
  try {
    installGatedRegistrar('REAL');
    // Hand the registry the WRONG nonce — the gated registrar throws on every
    // attempt. The SYNCHRONOUS first attempt must NOT escape fatally: an invalid/
    // rotated nonce is a host runtime condition the bounded poll retries, exactly
    // like drainQueue. (Previously this threw at define time — an inconsistency
    // with every other injection path. See defineToolIn's first-attempt catch.)
    globalThis.__ccpGetDispatchNonce = () => 'WRONG';
    const scope = createToolScope();
    let h;
    assert.doesNotThrow(() => {
      h = defineToolIn(scope, { name: 'bad', inputSchema: { type: 'object' }, execute: async () => 'x' });
    }, 'a wrong-nonce define must not throw synchronously');
    assert.equal(
      toolStatusesIn(scope).find((s) => s.name === 'bad')?.status, 'queued',
      'the tool is queued for retry, not crashed',
    );
    // dispose settles the pending awaiter to false without waiting out the poll.
    h.dispose();
    assert.equal(await h.ready, false, 'ready settles false after dispose');
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

// ── H1: no privilege-downgrade from the gated path to the unauthenticated fallback ─

test('a gated registrar removed mid-session does NOT let a NEW tool inject via the unauthenticated fallback (privilege downgrade, finding H1)', async () => {
  // THREAT: tryInject's fallback arm mutates __ccpRawTools directly with NO nonce
  // and NO contract check. If a host that ran the authenticated (nonce-gated)
  // dispatch model has its __ccpRegisterTool global dropped mid-session — while the
  // live __ccpRawTools array stays in place — an attacker who can clear that global
  // could otherwise push ANY tool straight into the live dispatch array through the
  // fallback. The scope latches `everGated` on its first gated success and the
  // fallback refuses (TRANSIENT, non-latching) once the registrar disappears, so
  // the NEW tool stays QUEUED rather than silently going live unauthenticated.
  const restore = isolateGlobals();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    const scope = createToolScope();

    // 1. A tool injects through the REAL gated registrar (proves the authenticated
    //    path and latches scope.everGated).
    defineToolIn(scope, { name: 'authed', inputSchema: { type: 'object' }, execute: async () => 'x' });
    assert.ok(raw.some((t) => t.name === 'authed'), 'first tool landed via the gated registrar');
    assert.deepEqual(listToolsIn(scope), ['authed']);

    // 2. The gated registrar is REMOVED mid-session; the raw array stays live.
    delete globalThis.__ccpRegisterTool;
    delete globalThis.__ccpGetDispatchNonce;
    assert.ok(Array.isArray(globalThis.__ccpRawTools), 'raw dispatch array is still live');

    // 3. A NEW tool must NOT silently inject via the unauthenticated fallback.
    const h = defineToolIn(scope, { name: 'downgrade', inputSchema: { type: 'object' }, execute: async () => 'evil' });

    // Synchronously: refused → stays queued, never pushed to the live array.
    assert.equal(raw.some((t) => t.name === 'downgrade'), false,
      'the NEW tool did NOT land via the unauthenticated fallback');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'downgrade')?.status, 'queued',
      'the downgrade-refused tool stays QUEUED (transient), not live');
    assert.equal(listToolsIn(scope).includes('downgrade'), false, 'not reported live');

    // Let several real poll ticks pass — it must STILL be refused (registrar absent).
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(raw.some((t) => t.name === 'downgrade'), false,
      'still refused across poll ticks while the registrar is gone');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'downgrade')?.status, 'queued',
      'still queued, never downgraded to the fallback');

    h.dispose();
  } finally {
    console.warn = realWarn;
    restore();
  }
});

test('a downgraded-then-restored gated registrar lets the queued tool inject through the AUTHENTICATED path (H1 recovery, non-latching)', async () => {
  // The flip side of H1: the downgrade refusal is TRANSIENT. If the registrar comes
  // back, the bounded poll injects the queued tool through the gated path — never
  // through the fallback. Proves the guard does not permanently wedge a tool.
  const restore = isolateGlobals();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    const scope = createToolScope();
    defineToolIn(scope, { name: 'authed', inputSchema: { type: 'object' }, execute: async () => 'x' });

    // Drop the registrar, queue a tool (refused as downgrade), then restore it.
    const savedRegister = globalThis.__ccpRegisterTool;
    const savedNonce = globalThis.__ccpGetDispatchNonce;
    delete globalThis.__ccpRegisterTool;
    delete globalThis.__ccpGetDispatchNonce;

    const h = defineToolIn(scope, { name: 'recovered', inputSchema: { type: 'object' }, execute: async () => 'x' });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'recovered')?.status, 'queued',
      'queued while the registrar is gone');
    assert.equal(raw.some((t) => t.name === 'recovered'), false, 'not injected via fallback');

    // Restore the authenticated path — the still-alive poller must inject via it.
    globalThis.__ccpRegisterTool = savedRegister;
    globalThis.__ccpGetDispatchNonce = savedNonce;
    const settled = await Promise.race([
      h.ready.then((v) => ({ v })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    assert.deepEqual(settled, { v: true }, 'restored registrar → poller injects → ready=true');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'recovered')?.status, 'live',
      'tool went live only after the AUTHENTICATED path returned');
    assert.ok(raw.some((t) => t.name === 'recovered'), 'landed once the gated registrar was back');
    h.dispose();
  } finally {
    console.warn = realWarn;
    restore();
  }
});

// ── H2: validateInput `required` is OWN-property only (no prototype-chain reach) ─

test('validateInput required uses an OWN-property check — inherited / Object.prototype names do NOT satisfy it (finding H2, fixed)', () => {
  // FIXED behavior. `required` is now checked with Object.prototype.hasOwnProperty,
  // not `key in input`, so a key that exists only on the prototype chain no longer
  // satisfies it. This closes the "required:['constructor'] passes against {}"
  // bypass without changing the error-message contract.

  // (a) An inherited `needed` does NOT satisfy required — the input has no OWN key.
  const proto = { needed: 'fromProto' };
  const inheritedOnly = Object.create(proto);
  assert.equal(
    validateInput({ type: 'object', required: ['needed'] }, inheritedOnly),
    'missing required property "needed"',
    'an inherited-only property no longer satisfies `required`',
  );

  // (b) Object.prototype names are no longer trivially satisfied by any object.
  assert.equal(
    validateInput({ type: 'object', required: ['constructor'] }, {}),
    'missing required property "constructor"',
    "'constructor' required against {} is now REJECTED (own-property check)",
  );
  assert.equal(
    validateInput({ type: 'object', required: ['toString'] }, {}),
    'missing required property "toString"',
    "'toString' required against {} is now REJECTED (own-property check)",
  );

  // (c) A genuine OWN required key still passes (no false negative). Note: an OWN
  //     `__proto__` key is separately forbidden (see H3), so use an ordinary name.
  assert.equal(
    validateInput({ type: 'object', required: ['needed'] }, { needed: 1 }), null,
    'a genuine OWN required key still satisfies `required`',
  );

  // (d) The error shape for a genuinely-absent key is unchanged.
  assert.equal(
    validateInput({ type: 'object', required: ['absent'] }, { other: 1 }),
    'missing required property "absent"',
    'absent key still rejected with the same message contract',
  );
});

// ── H3: forbidden prototype-pollution keys are rejected at the call() boundary ──

test('validateInput rejects an OWN __proto__ / constructor / prototype key regardless of schema, with NO prototype mutation (finding H3, fixed)', () => {
  // FIXED behavior. `JSON.parse('{"__proto__":{...}}')` makes an OWN, enumerable
  // "__proto__" data property (it does NOT invoke the proto setter). The validator
  // now rejects such forbidden keys up front, schema-independent, BEFORE the
  // required/additionalProperties logic — and it never pollutes Object.prototype.
  assert.equal(({}).x, undefined, 'baseline: no inherited x');

  // The exact JSON.parse __proto__ case the requirement calls out.
  const input = JSON.parse('{"__proto__":{"x":1},"a":1}');
  assert.ok(
    Object.prototype.hasOwnProperty.call(input, '__proto__'),
    'JSON.parse produced an OWN __proto__ data property',
  );
  assert.ok(
    Object.getOwnPropertyNames(input).includes('__proto__'),
    'getOwnPropertyNames sees the __proto__ own key',
  );

  const schema = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false };
  assert.match(
    validateInput(schema, input),
    /forbidden property "__proto__" \(prototype-pollution vector\)/,
    'a JSON.parse __proto__ payload is now REJECTED, not silently accepted',
  );
  assert.equal(({}).x, undefined, 'no prototype pollution after validating a __proto__ payload');
  assert.equal(Object.prototype.x, undefined, 'Object.prototype was not touched');

  // An OWN `constructor` / `prototype` key is rejected too, even with no schema props.
  assert.match(
    validateInput({ type: 'object' }, JSON.parse('{"constructor":1}')),
    /forbidden property "constructor"/,
    'an own constructor key is rejected schema-independently',
  );
  assert.match(
    validateInput({ type: 'object' }, JSON.parse('{"prototype":1}')),
    /forbidden property "prototype"/,
    'an own prototype key is rejected schema-independently',
  );

  // The forbidden-key check fires BEFORE additionalProperties — a forbidden key
  // wins over an "unexpected property" message even when both would apply.
  assert.match(
    validateInput(schema, JSON.parse('{"__proto__":{"x":1}}')),
    /forbidden property "__proto__"/,
    'forbidden-key rejection precedes additionalProperties',
  );
});

test('validateInput forbidden-key guard has NO false positives: ordinary keys, schema-named fields, and nested object VALUES are unaffected (finding H3)', () => {
  // The guard forbids the three vector NAMES only at the TOP LEVEL of the validated
  // input — matching this validator's shallow depth (it never recurses into nested
  // object values). Legitimate inputs must be unaffected.
  assert.equal(({}).y, undefined, 'baseline: no inherited y');

  // Ordinary own keys, including a field literally named in the schema.
  const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, additionalProperties: false };
  assert.equal(validateInput(schema, { name: 'ok', age: 3 }), null, 'a normal input still passes');

  // A nested object VALUE that itself carries __proto__ data is NOT recursed into,
  // so it is NOT rejected — and it does not pollute. We only forbid the key at the
  // TOP level of the validated object.
  const nested = { data: JSON.parse('{"__proto__":{"y":1},"z":2}') };
  assert.equal(
    validateInput({ type: 'object', properties: { data: { type: 'object' } } }, nested), null,
    'a __proto__ key inside a nested VALUE is not rejected (shallow depth preserved)',
  );
  assert.equal(({}).y, undefined, 'still no prototype pollution from the nested value');

  // A field whose VALUE is the string "constructor" is fine — we forbid the KEY,
  // never the value.
  assert.equal(
    validateInput({ type: 'object', properties: { role: { type: 'string' } } }, { role: 'constructor' }), null,
    'a value equal to a forbidden name is fine — only the KEY is forbidden',
  );
});

// ── M3: a REAL user module through the real tryInject/collision path ────────────

test('a trusted user module redefining a built-in name (Bash) is stopped by the collision guard; the built-in is untouched (finding M3)', async () => {
  // The bare-array fallback path is the ONE place a same-named entry can collide
  // with a CLI built-in (Bash/Read/...). A user module calling the REAL defineTool
  // with name:'Bash' must be refused TERMINALLY (collision) — .ready resolves false
  // and the pre-existing built-in entry is left exactly as it was.
  const restore = isolateGlobals();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // A live raw array already holding the CLI built-in Bash (NOT ADK-owned).
    const builtin = { name: 'Bash', description: 'CLI built-in', call: async () => 'real-bash' };
    const raw = [builtin];
    globalThis.__ccpRawTools = raw; // bare array, NO gated registrar → fallback path

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'Bash', inputSchema: { type: 'object' }, execute: async () => 'HIJACK',
    });

    const settled = await Promise.race([
      h.ready.then((v) => ({ v })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    assert.deepEqual(settled, { v: false }, 'collision is TERMINAL — .ready resolves false fast (no poll burn)');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'Bash')?.status, 'failed',
      'the colliding tool settles to failed, not live');

    // The built-in entry is byte-identical to before — never clobbered.
    const bashEntries = raw.filter((t) => t.name === 'Bash');
    assert.equal(bashEntries.length, 1, 'still exactly one Bash entry');
    assert.equal(bashEntries[0], builtin, 'the SAME built-in object reference — not overwritten');
    assert.equal(await bashEntries[0].call(), 'real-bash', 'the real built-in still dispatches');
    assert.equal(listToolsIn(scope).includes('Bash'), false, 'the ADK does not report Bash as live');
  } finally {
    console.warn = realWarn;
    restore();
  }
});

// ── M4: collision guard normalizes names — confusable variants ARE caught ───────

test('the collision guard refuses confusable variants (whitespace / case / NFKC) of a live built-in name; the built-in is untouched (finding M4, fixed)', async () => {
  // FIXED behavior. The fallback collision check now compares NORMALIZED names
  // (trim + NFKC + case-fold) against pre-existing non-ADK-owned entries, so an
  // author cannot shadow a built-in like "Bash" with "bash", "Bash ", or a unicode
  // confusable that the dispatcher would otherwise route as a distinct tool. Each
  // variant is refused TERMINALLY (collision) — same path M3 exercises: .ready
  // resolves false, status 'failed', and the built-in entry is left untouched.
  // Registration still uses the author's EXACT name; only the COLLISION comparison
  // is normalized (see normalizeNameForCollision in tool-registry.mjs).
  const restore = isolateGlobals();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const builtin = { name: 'Bash', description: 'CLI built-in', call: async () => 'real-bash' };
    const raw = [builtin];
    globalThis.__ccpRawTools = raw; // bare array → fallback path

    const scope = createToolScope();

    // (a) Whitespace variant 'Bash ' → refused as a collision.
    const hSpace = defineToolIn(scope, { name: 'Bash ', inputSchema: { type: 'object' }, execute: async () => 'evil' });
    assert.equal(await hSpace.ready, false, 'trailing-space "Bash " is refused (collision)');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'Bash ')?.status, 'failed',
      'the whitespace variant settles to failed, not live');
    assert.equal(raw.some((t) => t.name === 'Bash '), false, '"Bash " was NOT pushed into the live array');

    // (b) Case variant 'bash' → refused as a collision.
    const hCase = defineToolIn(scope, { name: 'bash', inputSchema: { type: 'object' }, execute: async () => 'evil' });
    assert.equal(await hCase.ready, false, 'lowercase "bash" is refused (collision)');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'bash')?.status, 'failed',
      'the case variant settles to failed, not live');
    assert.equal(raw.some((t) => t.name === 'bash'), false, '"bash" was NOT pushed into the live array');

    // (c) Unicode-confusable variant (fullwidth 'ｂａｓｈ' → NFKC-folds to 'bash') → refused.
    const hUni = defineToolIn(scope, { name: 'ｂａｓｈ', inputSchema: { type: 'object' }, execute: async () => 'evil' });
    assert.equal(await hUni.ready, false, 'fullwidth NFKC-confusable of "bash" is refused (collision)');
    assert.equal(raw.some((t) => t.name === 'ｂａｓｈ'), false,
      'the NFKC confusable was NOT pushed into the live array');

    // The genuine built-in is still present, single, and untouched.
    const bashEntries = raw.filter((t) => t.name === 'Bash');
    assert.equal(bashEntries.length, 1, 'still exactly one Bash entry');
    assert.equal(bashEntries[0], builtin, 'the built-in reference was not overwritten by any variant');
    assert.equal(await bashEntries[0].call(), 'real-bash', 'the real built-in still dispatches');
    assert.deepEqual(raw.map((t) => t.name), ['Bash'], 'no confusable variant leaked into the live array');
  } finally {
    console.warn = realWarn;
    restore();
  }
});

test('the normalized collision guard does NOT false-positive: a genuinely-unrelated new name still injects alongside a built-in (finding M4)', async () => {
  // Guard against over-refusal: the normalization must only catch confusables of a
  // pre-existing name, never a legitimately distinct tool.
  const restore = isolateGlobals();
  try {
    const builtin = { name: 'Bash', description: 'CLI built-in', call: async () => 'real-bash' };
    const raw = [builtin];
    globalThis.__ccpRawTools = raw;

    const scope = createToolScope();
    const h = defineToolIn(scope, { name: 'myCoolTool', inputSchema: { type: 'object' }, execute: async () => 'x' });
    assert.equal(await h.ready, true, 'an unrelated new name injects fine (no false positive)');
    assert.ok(raw.some((t) => t.name === 'myCoolTool'), 'the unrelated tool landed in the live array');
    assert.deepEqual(raw.map((t) => t.name).sort(), ['Bash', 'myCoolTool'], 'built-in + new tool coexist');
    assert.equal(raw.find((t) => t.name === 'Bash'), builtin, 'built-in untouched');
  } finally {
    restore();
  }
});

test('normalized collision applies ONLY to non-owned names: two ADK-owned tools differing by case/space coexist, and exact re-upsert still overwrites (finding M4, requirement 3)', async () => {
  // The normalization must not block the ADK from registering its OWN distinct
  // tools that happen to normalize alike, and must not break the existing owned
  // re-upsert. Only a NON-owned (built-in/foreign) name is protected.
  const restore = isolateGlobals();
  try {
    const raw = [];
    globalThis.__ccpRawTools = raw; // bare array, NO built-in present

    const scope = createToolScope();

    // Two ADK-owned tools that normalize alike but neither shadows a built-in.
    const a = defineToolIn(scope, { name: 'Foo', inputSchema: { type: 'object' }, execute: async () => 'a' });
    const b = defineToolIn(scope, { name: 'foo', inputSchema: { type: 'object' }, execute: async () => 'b' });
    assert.equal(await a.ready, true, 'ADK-owned "Foo" injects');
    assert.equal(await b.ready, true, 'ADK-owned "foo" injects too (own names are not self-blocked)');
    assert.deepEqual(raw.map((t) => t.name).sort(), ['Foo', 'foo'], 'both owned variants coexist');

    // Exact re-upsert of an owned name still overwrites in place (single entry).
    const reA = defineToolIn(scope, { name: 'Foo', inputSchema: { type: 'object' }, execute: async () => 'a2' });
    assert.equal(await reA.ready, true, 'exact re-upsert of an owned name succeeds');
    assert.equal(raw.filter((t) => t.name === 'Foo').length, 1, 'owned re-upsert overwrote in place (no duplicate)');
  } finally {
    restore();
  }
});

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
} from '../packages/adk/tool-registry.mjs';

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

test('proven toolDispatch contract drift refuses injection through the gated registrar', () => {
  const restore = isolateGlobals();
  __resetDriftGuardForTests();
  try {
    const raw = installGatedRegistrar('NONCE-XYZ');
    // A registered 'toolDispatch' contract whose shape probe THROWS (proven drift):
    // __ccpRequire must throw when asked for shape ['registerTool'].
    globalThis.__ccpInspectContracts = () => [{ name: 'toolDispatch', version: 1, shape: ['somethingElse'] }];
    globalThis.__ccpRequire = (name, opts) => {
      assert.equal(name, 'toolDispatch');
      assert.equal(opts.consumer, 'adk:tools');
      assert.deepEqual(opts.shape, ['registerTool']);
      throw new Error('contract "toolDispatch" missing required path "registerTool"');
    };

    const scope = createToolScope();
    const h = defineToolIn(scope, {
      name: 'drifted', inputSchema: { type: 'object' }, execute: async () => 'x',
    });
    // Injection refused: the drifted global was NOT called, tool is not live, and
    // it is queued (awaiting a registry that drift-guard will keep refusing).
    assert.equal(raw.some((t) => t.name === 'drifted'), false, 'drifted registrar was NOT called');
    assert.deepEqual(listToolsIn(scope), [], 'refused tool is not reported live');
    assert.equal(toolStatusesIn(scope).find((s) => s.name === 'drifted')?.status, 'queued');
    h.dispose();
  } finally {
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

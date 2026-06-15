/**
 * adk-host.test.mjs
 *
 * Coverage for the host port (host.mjs) and the createAdk() isolation-contract
 * additions:
 *   - every accessor reads globalThis LIVE (no import-time snapshot) so test
 *     stubs assigned AFTER import are honored, and a removed global flips back
 *     to the empty result;
 *   - probes never throw and return falsy/empty on an absent global;
 *   - host.emit() is fully guarded (no-op without a bus; swallows a throwing
 *     observer);
 *   - createAdk() exposes a stable, unique `id`;
 *   - the three process-global methods (capabilities / useAgentBus / createMemory)
 *     are the SAME references on an instance as the DEFAULT exports — i.e. they
 *     are intentionally NOT re-scoped, matching the documented contract.
 *
 * Plain ESM, no patched CLI, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { host } from '../host.mjs';
import {
  createAdk, capabilities, useAgentBus, createMemory,
} from '../index.mjs';

/** Snapshot + clear the globals this file pokes; returns a restorer. */
function isolateGlobals() {
  const keys = [
    '__ccpRawTools', '__ccpAgentTool', '__ccpSetSystemPrompt',
    '__ccpGetSystemPrompt', '__ccpSystemPromptOverride', '__ccpSubmitInput',
    '__ccpBus', '__ccpInspectContracts', '__ccpRequire',
    '__ccpRegisterTool', '__ccpUnregisterTool', '__ccpGetDispatchNonce',
    '__ccpGetSystemPromptNonce', '__ccp_path', '__ccpDebug',
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

// ── live reads ────────────────────────────────────────────────────────────────

test('host reads globalThis LIVE — stub assigned after import is honored', () => {
  const restore = isolateGlobals();
  try {
    assert.equal(host.hasRawTools(), false, 'absent → false');
    assert.equal(host.rawTools(), undefined, 'absent → undefined');

    globalThis.__ccpRawTools = [];
    assert.equal(host.hasRawTools(), true, 'present → true (no import-time snapshot)');
    assert.ok(Array.isArray(host.rawTools()), 'returns the live array');

    delete globalThis.__ccpRawTools;
    assert.equal(host.hasRawTools(), false, 'removed → flips back to false');
  } finally {
    restore();
  }
});

test('host capability probes never throw and are falsy when absent', () => {
  const restore = isolateGlobals();
  try {
    assert.doesNotThrow(() => {
      host.hasDelegate(); host.hasSetSystemPrompt(); host.hasSubmitInput();
      host.hasBus(); host.hasRegisterTool(); host.hasUnregisterTool();
      host.getDispatchNonce(); host.getSystemPrompt(); host.systemPromptOverride();
      host.agentTool(); host.submitInput(); host.bus(); host.path();
      host.inspectContracts(); host.requireFn(); host.debug();
    });
    assert.equal(host.hasDelegate(), false);
    assert.equal(host.hasSetSystemPrompt(), false);
    assert.equal(host.hasSubmitInput(), false);
    assert.equal(host.hasBus(), false);
    assert.equal(host.getSystemPrompt(), null, 'null when no getter');
    assert.equal(host.systemPromptOverride(), null, 'null when no override slot');
    assert.equal(host.debug(), false, 'debug off when neither source is set');
  } finally {
    restore();
  }
});

test('host.getSystemPrompt() prefers the live getter', () => {
  const restore = isolateGlobals();
  try {
    globalThis.__ccpGetSystemPrompt = () => 'live-persona';
    assert.equal(host.getSystemPrompt(), 'live-persona');
    assert.equal(typeof host.systemPromptGetterRaw(), 'function');
  } finally {
    restore();
  }
});

test('host.debug() honors __ccpDebug', () => {
  const restore = isolateGlobals();
  try {
    assert.equal(host.debug(), false);
    globalThis.__ccpDebug = true;
    assert.equal(host.debug(), true);
  } finally {
    restore();
  }
});

// ── guarded emit ────────────────────────────────────────────────────────────

test('host.emit() is a no-op without a bus and swallows a throwing observer', () => {
  const restore = isolateGlobals();
  try {
    assert.doesNotThrow(() => host.emit('x', { a: 1 }), 'no bus → no throw');

    const seen = [];
    globalThis.__ccpBus = {
      emit(topic, payload) {
        seen.push([topic, payload]);
        throw new Error('observer boom');
      },
    };
    assert.doesNotThrow(() => host.emit('y', { b: 2 }), 'throwing bus → swallowed');
    assert.deepEqual(seen, [['y', { b: 2 }]], 'the emit still reached the bus');
  } finally {
    restore();
  }
});

// ── unified report() seam (COD-8) ─────────────────────────────────────────────

/** Install a capturing bus + console.warn stub; returns {events, logs, restore}. */
function captureBusAndWarn() {
  const events = [];
  const logs = [];
  const prevBus = globalThis.__ccpBus;
  const realWarn = console.warn;
  globalThis.__ccpBus = { emit: (topic, payload) => events.push({ topic, payload }) };
  console.warn = (m) => logs.push(String(m));
  return {
    events,
    logs,
    restore() {
      console.warn = realWarn;
      if (prevBus === undefined) delete globalThis.__ccpBus;
      else globalThis.__ccpBus = prevBus;
    },
  };
}

test('host.report() ALWAYS emits to the bus, at every level (incl. silent)', () => {
  const restore = isolateGlobals();
  const cap = captureBusAndWarn();
  try {
    for (const level of ['error', 'warn', 'debug', 'silent']) {
      host.report(level, `evt.${level}`, { message: `m-${level}` });
    }
    assert.deepEqual(
      cap.events.map((e) => e.topic),
      ['evt.error', 'evt.warn', 'evt.debug', 'evt.silent'],
      'every level — including silent — reached the bus',
    );
    assert.deepEqual(
      cap.events.find((e) => e.topic === 'evt.silent').payload,
      { message: 'm-silent' },
      'the structured detail is the bus payload',
    );
  } finally {
    cap.restore();
    restore();
  }
});

test("host.report('silent', …) suppresses the console line but is a deliberate emit", () => {
  const restore = isolateGlobals();
  const cap = captureBusAndWarn();
  try {
    globalThis.__ccpDebug = true; // even with debug ON, silent must not log.
    host.report('silent', 'memory.lock.contended', { path: '/tmp/x' });
    assert.equal(cap.logs.length, 0, "silent NEVER logs, even under host.debug()");
    assert.deepEqual(
      cap.events,
      [{ topic: 'memory.lock.contended', payload: { path: '/tmp/x' } }],
      'silent still emits to the bus — a deliberate bus-only path, not a dropped signal',
    );
  } finally {
    cap.restore();
    restore();
  }
});

test("host.report('warn'|'error') always logs a tagged line; 'debug' is gated on host.debug()", () => {
  const restore = isolateGlobals();
  let cap = captureBusAndWarn();
  try {
    // debug OFF: warn/error log, debug does NOT (but all three still emit).
    host.report('warn', 'a.warn', { message: 'w' });
    host.report('error', 'a.error', { message: 'e' });
    host.report('debug', 'a.debug', { message: 'd' });
    assert.deepEqual(cap.logs, ['[adk] a.warn: w', '[adk] a.error: e'], 'warn+error logged, debug muted');
    assert.deepEqual(cap.events.map((x) => x.topic), ['a.warn', 'a.error', 'a.debug'], 'all three emitted');
  } finally {
    cap.restore();
  }

  cap = captureBusAndWarn();
  try {
    globalThis.__ccpDebug = true; // debug ON: the debug line now logs too.
    host.report('debug', 'b.debug', { reason: 'why' });
    assert.deepEqual(cap.logs, ['[adk] b.debug: why'], "debug logs under host.debug(); uses .reason");
  } finally {
    cap.restore();
    restore();
  }
});

test('host.report() never throws (fail-open) even when the bus observer and console both throw', () => {
  const restore = isolateGlobals();
  const realWarn = console.warn;
  try {
    globalThis.__ccpBus = { emit() { throw new Error('observer boom'); } };
    console.warn = () => { throw new Error('console boom'); };
    assert.doesNotThrow(() => host.report('warn', 'boom', { message: 'x' }), 'report swallows both failures');
  } finally {
    console.warn = realWarn;
    restore();
  }
});

// ── createAdk() id + process-global method identity ──────────────────────────

test('createAdk() exposes a stable, unique id', () => {
  const a = createAdk();
  const b = createAdk();
  try {
    assert.equal(typeof a.id, 'string');
    assert.match(a.id, /^adk-\d+$/);
    assert.notEqual(a.id, b.id, 'two instances get distinct ids');
    assert.equal(a.id, a.id, 'id is stable for one instance');
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('process-global methods are NOT re-scoped — same refs as DEFAULT exports', () => {
  const a = createAdk();
  try {
    // Per the ISOLATION CONTRACT, these front single global resources and are
    // intentionally shared rather than instance-scoped.
    assert.equal(a.capabilities, capabilities, 'capabilities is the shared probe');
    assert.equal(a.useAgentBus, useAgentBus, 'useAgentBus returns the one bus');
    assert.equal(a.createMemory, createMemory, 'createMemory is path-keyed, shared');
  } finally {
    a.dispose();
  }
});

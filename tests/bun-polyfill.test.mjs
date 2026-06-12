// tests/bun-polyfill.test.mjs — runtime behavior tests for the Bun polyfill
// payload (runner/shims/bun-polyfill-v1.js.txt).
//
// The payload is evaluated in an isolated vm context (own globalThis, stub
// process so the fullscreen-guard env write never touches the real
// environment), then the installed Bun object is exercised directly. Today
// this covers the surface most likely to corrupt state silently if wrong:
// Bun.deepEquals — the bundle calls it on API-state object values
// (Bun.deepEquals(_, f)), so a wrong verdict flips change-detection logic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD_PATH = path.join(ROOT, 'runner', 'shims', 'bun-polyfill-v1.js.txt');

/** Evaluate the polyfill payload in a fresh vm context; return its Bun object. */
function installShim() {
  const payload = fs.readFileSync(PAYLOAD_PATH, 'utf8');
  const sandbox = {
    // Stub process: the payload reads/writes env (fullscreen guard) and wires
    // stdin/stdout/stderr/argv into the Bun object. Keep it self-contained so
    // the test never mutates the real process.
    process: {
      env: {},
      argv: ['node', '/tmp/fixture.js'],
      stdin: {}, stdout: {}, stderr: {},
      cwd: () => '/',
      exit: () => {},
    },
    console,
    require: createRequire(import.meta.url),
    Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    // Host intrinsics the shim type-checks against (instanceof / isView).
    // In production the shim shares the bundle's realm; without these the vm
    // realm's own constructors would make host-built test values fail every
    // instanceof — a test artifact, not a shim behavior.
    Date, RegExp, Map, Set, WeakMap, WeakSet, ArrayBuffer, Uint8Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(payload, sandbox, { filename: 'bun-polyfill-v1.js.txt' });
  assert.ok(sandbox.Bun, 'payload should install globalThis.Bun in the sandbox');
  return sandbox.Bun;
}

const Bun = installShim();

describe('Bun polyfill payload (vm-evaluated)', () => {
  it('installs every API classified in refmaps/bun-api-coverage.json', () => {
    const coverage = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'refmaps', 'bun-api-coverage.json'), 'utf8')
    );
    for (const name of Object.keys(coverage.apis)) {
      assert.ok(name in Bun, `Bun.${name} missing from the installed shim object`);
    }
  });
});

describe('Bun.deepEquals shim', () => {
  it('primitives: identity, NaN, cross-type', () => {
    assert.equal(Bun.deepEquals(1, 1), true);
    assert.equal(Bun.deepEquals('a', 'a'), true);
    assert.equal(Bun.deepEquals(NaN, NaN), true);
    assert.equal(Bun.deepEquals(0, '0'), false);
    assert.equal(Bun.deepEquals(null, undefined), false);
    assert.equal(Bun.deepEquals(null, {}), false);
  });

  it('plain objects and arrays, nested (the bundle call shape)', () => {
    assert.equal(Bun.deepEquals({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2 }] }), true);
    assert.equal(Bun.deepEquals({ a: 1 }, { a: 2 }), false);
    assert.equal(Bun.deepEquals({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(Bun.deepEquals([1, 2, 3], [1, 2, 3]), true);
    assert.equal(Bun.deepEquals([1, 2, 3], [1, 2]), false);
    assert.equal(Bun.deepEquals([1, 2], { 0: 1, 1: 2 }), false);
  });

  it('non-strict ignores undefined-valued keys; strict does not', () => {
    assert.equal(Bun.deepEquals({ a: 1 }, { a: 1, b: undefined }), true);
    assert.equal(Bun.deepEquals({ a: 1 }, { a: 1, b: undefined }, true), false);
  });

  it('strict requires matching prototypes', () => {
    class Box { constructor(v) { this.v = v; } }
    assert.equal(Bun.deepEquals(new Box(1), { v: 1 }), true);
    assert.equal(Bun.deepEquals(new Box(1), { v: 1 }, true), false);
  });

  it('Date, RegExp, Map, Set, typed arrays', () => {
    assert.equal(Bun.deepEquals(new Date(123), new Date(123)), true);
    assert.equal(Bun.deepEquals(new Date(123), new Date(456)), false);
    assert.equal(Bun.deepEquals(/ab/g, /ab/g), true);
    assert.equal(Bun.deepEquals(/ab/g, /ab/i), false);
    assert.equal(Bun.deepEquals(new Map([['k', { v: 1 }]]), new Map([['k', { v: 1 }]])), true);
    assert.equal(Bun.deepEquals(new Map([['k', 1]]), new Map([['k', 2]])), false);
    assert.equal(Bun.deepEquals(new Set([1, 2]), new Set([2, 1])), true);
    assert.equal(Bun.deepEquals(new Set([1]), new Set([2])), false);
    assert.equal(Bun.deepEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(Bun.deepEquals(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  });

  it('survives cyclic structures without blowing the stack', () => {
    const a = { x: 1 }; a.self = a;
    const b = { x: 1 }; b.self = b;
    assert.equal(Bun.deepEquals(a, b), true);
    const c = { x: 2 }; c.self = c;
    assert.equal(Bun.deepEquals(a, c), false);
  });
});

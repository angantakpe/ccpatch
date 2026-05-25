import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import contractsPatch from '../core/contracts.mjs';

/**
 * Run the contracts kernel hook in a fresh VM context per test and return
 * the context's globalThis so tests can call __ccpProvide / __ccpRequire.
 *
 * The kernel references `process.stderr.write` for the duplicate-producer
 * warning; we inject a minimal stub so that path doesn't crash.
 */
function freshKernel() {
  const ctx = vm.createContext({
    process: { stderr: { write() {} } },
  });
  vm.runInContext(contractsPatch.preloadCode, ctx);
  return ctx;
}

describe('contracts kernel — preloadCode runtime', () => {
  it('installs Provide / Require / InspectContracts on globalThis', () => {
    const g = freshKernel();
    assert.equal(typeof g.__ccpProvide, 'function');
    assert.equal(typeof g.__ccpRequire, 'function');
    assert.equal(typeof g.__ccpInspectContracts, 'function');
    // Cross-realm: Map constructor in VM context !== host Map, so test by shape.
    assert.equal(typeof g.__ccpRegistry.set, 'function');
    assert.equal(typeof g.__ccpRegistry.get, 'function');
  });

  it('roundtrips a simple value', () => {
    const g = freshKernel();
    const value = { messages: { stream: () => 'ok' } };
    g.__ccpProvide('apiClient', {
      version: 1,
      producer: 'test_producer',
      shape: ['messages.stream'],
      value,
    });
    const got = g.__ccpRequire('apiClient', {
      consumer: 'test_consumer',
      minVersion: 1,
      shape: ['messages.stream'],
    });
    assert.strictEqual(got, value);
  });

  it('returns the value even when no shape probe is requested', () => {
    const g = freshKernel();
    const value = { anything: 1 };
    g.__ccpProvide('thing', { version: 1, producer: 'p', value });
    assert.strictEqual(g.__ccpRequire('thing', { consumer: 'c' }), value);
  });
});

describe('contracts kernel — failure modes', () => {
  it('throws with producer-aware message when contract is missing', () => {
    const g = freshKernel();
    assert.throws(
      () => g.__ccpRequire('apiClient', { consumer: 'shadow_runner' }),
      /consumer "shadow_runner" requires contract "apiClient"[\s\S]*no producer/,
    );
  });

  it('throws on version mismatch and reports producer version', () => {
    const g = freshKernel();
    g.__ccpProvide('apiClient', { version: 1, producer: 'expose_api_client', value: {} });
    assert.throws(
      () => g.__ccpRequire('apiClient', { consumer: 'x', minVersion: 2 }),
      /requires "apiClient" v>=2 but producer "expose_api_client" provides v1/,
    );
  });

  it('throws on missing dotted-path shape probe', () => {
    const g = freshKernel();
    g.__ccpProvide('apiClient', {
      version: 1,
      producer: 'expose_api_client',
      shape: ['messages.stream'],
      value: { messages: {} }, // missing .stream
    });
    assert.throws(
      () => g.__ccpRequire('apiClient', {
        consumer: 'shadow_runner',
        shape: ['messages.stream'],
      }),
      /"apiClient" provided by "expose_api_client"[\s\S]*missing required path "messages.stream"/,
    );
  });

  it('throws on a partially-resolved nested path (intermediate is null)', () => {
    const g = freshKernel();
    g.__ccpProvide('apiClient', {
      version: 1,
      producer: 'expose_api_client',
      value: { beta: null },
    });
    assert.throws(
      () => g.__ccpRequire('apiClient', {
        consumer: 'x',
        shape: ['beta.messages.stream'],
      }),
      /missing required path "beta.messages.stream"/,
    );
  });

  it('rejects empty/invalid name', () => {
    const g = freshKernel();
    assert.throws(() => g.__ccpProvide('', { version: 1, value: {} }), /non-empty string/);
    assert.throws(() => g.__ccpProvide(null, { version: 1, value: {} }), /non-empty string/);
  });

  it('rejects missing spec', () => {
    const g = freshKernel();
    assert.throws(() => g.__ccpProvide('foo'), /spec must be an object/);
  });
});

describe('contracts kernel — duplicate-producer behavior', () => {
  let stderrChunks;
  let g;
  beforeEach(() => {
    stderrChunks = [];
    g = vm.createContext({
      process: { stderr: { write(s) { stderrChunks.push(s); } } },
    });
    vm.runInContext(contractsPatch.preloadCode, g);
  });

  it('warns on stderr when a different producer overwrites the same name', () => {
    g.__ccpProvide('apiClient', { version: 1, producer: 'patchA', value: { a: 1 } });
    g.__ccpProvide('apiClient', { version: 2, producer: 'patchB', value: { b: 2 } });
    const warned = stderrChunks.join('');
    assert.match(warned, /already provided by "patchA"/);
    assert.match(warned, /overwritten by "patchB"/);
    // Latest wins.
    assert.strictEqual(
      g.__ccpRequire('apiClient', { consumer: 'c', minVersion: 2 }).b,
      2,
    );
  });

  it('does NOT warn when the same producer re-registers (idempotent refresh)', () => {
    g.__ccpProvide('apiClient', { version: 1, producer: 'patchA', value: { a: 1 } });
    g.__ccpProvide('apiClient', { version: 1, producer: 'patchA', value: { a: 2 } });
    assert.equal(stderrChunks.length, 0);
    assert.strictEqual(g.__ccpRequire('apiClient', { consumer: 'c' }).a, 2);
  });
});

describe('contracts kernel — inspection', () => {
  it('lists registered contracts without their values', () => {
    const g = freshKernel();
    g.__ccpProvide('apiClient', {
      version: 1, producer: 'expose_api_client',
      shape: ['messages.stream'], value: { secret: 42 },
    });
    g.__ccpProvide('agentTool', {
      version: 1, producer: 'expose_agent_tool',
      shape: ['_capture'], value: { _capture() {} },
    });
    const out = g.__ccpInspectContracts();
    assert.equal(out.length, 2);
    // Cross-realm: rebuild a plain host array before deepEqual.
    const names = [...out].map(e => e.name).sort();
    assert.deepEqual(names, ['agentTool', 'apiClient']);
    for (const entry of out) {
      assert.equal(typeof entry.version, 'number');
      assert.equal(typeof entry.producer, 'string');
      // entry.shape is a VM-context array; check length/iteration instead of instanceof.
      assert.equal(typeof entry.shape.length, 'number');
      assert.ok(!('value' in entry), 'inspection should NOT expose values');
    }
  });
});

describe('contracts kernel — re-running the hook is idempotent', () => {
  it('does not reset the registry on second eval', () => {
    const g = freshKernel();
    g.__ccpProvide('x', { version: 1, producer: 'p', value: 'hello' });
    vm.runInContext(contractsPatch.preloadCode, g); // re-run
    assert.strictEqual(g.__ccpRequire('x', { consumer: 'c' }), 'hello');
  });
});

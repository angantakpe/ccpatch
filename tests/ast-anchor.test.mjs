import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findFunctionByLiteral, resetBundleIndex } from '../runner/ast-anchor.mjs';

describe('findFunctionByLiteral', () => {
  it('finds the named function wrapping a literal', () => {
    const code = 'var pre=0;function Qx7(){return helper("tengu_test_flag",!1)};var post=1;';
    const res = findFunctionByLiteral(code, 'tengu_test_flag');
    assert.ok(res);
    assert.equal(res.name, 'Qx7');
    assert.ok(code.slice(res.start, res.end).startsWith('function Qx7'));
    assert.ok(code.slice(res.start, res.end).includes('tengu_test_flag'));
  });

  it('returns null when no function wraps the literal', () => {
    const code = 'var pre=0;function Qx7(){return helper("tengu_test_flag",!1)};';
    assert.equal(findFunctionByLiteral(code, 'no_such_literal'), null);
  });
});

describe('per-code index (ARCH3)', () => {
  it('does not cross-contaminate between two distinct code strings', () => {
    // Same literal lives in differently-named functions in two bundles.
    const codeA = 'function AAA(){return f("shared_literal",1)};';
    const codeB = 'function BBB(){return f("shared_literal",2)};';

    const a1 = findFunctionByLiteral(codeA, 'shared_literal');
    const b1 = findFunctionByLiteral(codeB, 'shared_literal');
    // Interleave again to exercise the per-code cache rather than a 1-slot global.
    const a2 = findFunctionByLiteral(codeA, 'shared_literal');
    const b2 = findFunctionByLiteral(codeB, 'shared_literal');

    assert.equal(a1.name, 'AAA');
    assert.equal(b1.name, 'BBB');
    assert.equal(a2.name, 'AAA');
    assert.equal(b2.name, 'BBB');
    // Offsets must stay bundle-correct after interleaving.
    assert.equal(a1.start, a2.start);
    assert.equal(b1.start, b2.start);
  });

  it('returns identical results whether or not the cache is warm', () => {
    const code = 'var z=9;function Cee(){return g("warm_literal")};';
    const cold = findFunctionByLiteral(code, 'warm_literal');
    const warm = findFunctionByLiteral(code, 'warm_literal');
    assert.deepEqual(cold, warm);
  });

  it('handles many interleaved bundles beyond the LRU cap without corruption', () => {
    const bundles = [];
    for (let i = 0; i < 20; i++) {
      bundles.push(`function Fn${i}(){return h("lit_${i}")};`);
    }
    // First pass populates; second pass evicts/re-populates as the LRU rotates.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < bundles.length; i++) {
        const res = findFunctionByLiteral(bundles[i], `lit_${i}`);
        assert.ok(res, `bundle ${i} pass ${pass} should resolve`);
        assert.equal(res.name, `Fn${i}`);
      }
    }
  });
});

describe('resetBundleIndex', () => {
  it('is a no-op-safe clear that keeps lookups correct afterward', () => {
    const code = 'function Reset1(){return k("reset_lit")};';
    const before = findFunctionByLiteral(code, 'reset_lit');
    assert.equal(before.name, 'Reset1');

    // Clearing the cache must not change subsequent results.
    resetBundleIndex();
    const after = findFunctionByLiteral(code, 'reset_lit');
    assert.deepEqual(before, after);
  });

  it('can be called with no cached bundles', () => {
    resetBundleIndex();
    assert.doesNotThrow(() => resetBundleIndex());
  });
});

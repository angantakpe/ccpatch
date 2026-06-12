import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findFunctionByLiteral, resetBundleIndex } from '../runner/ast-anchor.mjs';
import { resetAstCache } from '../runner/ast-cache.mjs';

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

  it('resolves a literal whose enclosing `function` keyword sits >400 bytes earlier (Lane B)', () => {
    // The old fixed 400-byte backward window was a CORRECTNESS ceiling: a literal
    // genuinely inside a large (minified) function whose `function ` keyword lives
    // farther back than 400 bytes would silently fail to resolve. The adaptive
    // window must now grow and still find it.
    const filler = 'var x=0;'.repeat(120); // ~960 bytes between `function` and the literal
    const code = `function Big(){${filler}return helper("deep_literal",1)}`;
    assert.ok(code.indexOf('"deep_literal"') - code.indexOf('function Big') > 400,
      'fixture must place the literal >400 bytes after the function keyword');
    const res = findFunctionByLiteral(code, 'deep_literal');
    assert.ok(res, 'literal in a large function should still resolve');
    assert.equal(res.name, 'Big');
    assert.ok(code.slice(res.start, res.end).startsWith('function Big'));
  });

  it('picks the INNERMOST enclosing function when functions nest', () => {
    // outer() contains inner(); the literal lives inside inner(). The brace-walker
    // verification must select inner (the nearest truly-enclosing function), not
    // outer.
    const code =
      'function outer(){var a=1;function inner(){return helper("nested_literal",2)}return inner()}';
    const res = findFunctionByLiteral(code, 'nested_literal');
    assert.ok(res);
    assert.equal(res.name, 'inner');
    const text = code.slice(res.start, res.end);
    assert.ok(text.startsWith('function inner'));
    // The resolved span must NOT swallow the outer function.
    assert.ok(!text.includes('function outer'));
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

describe('bounded multi-bundle identity cache', () => {
  it('stays correct when more bundles than cache slots interleave', () => {
    resetBundleIndex();
    // 6 distinct bundles > MAX_BUNDLE_SLOTS (4): forces evictions while
    // alternating, the scenario the old single slot thrashed on. Resolution
    // must stay correct for every bundle on every pass (a miss recomputes).
    const bundles = Array.from({ length: 6 }, (_, i) =>
      `function Multi${i}(){return h("multi_lit_${i}")};`);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < bundles.length; i++) {
        const res = findFunctionByLiteral(bundles[i], `multi_lit_${i}`);
        assert.ok(res, `bundle ${i} pass ${pass} should resolve`);
        assert.equal(res.name, `Multi${i}`);
      }
    }
    resetBundleIndex();
  });
});

describe('resetAstCache', () => {
  it('clears the AST cache and keeps findFunctionByLiteral correct afterward', () => {
    // findFunctionByLiteral parses via getAst (which is backed by the AST cache).
    const code = 'function AstReset1(){return q("ast_reset_lit")};';
    const before = findFunctionByLiteral(code, 'ast_reset_lit');
    assert.equal(before.name, 'AstReset1');
    resetAstCache();
    const after = findFunctionByLiteral(code, 'ast_reset_lit');
    assert.deepEqual(after, before);
  });

  it('is safe to call with an empty cache', () => {
    resetAstCache();
    assert.doesNotThrow(() => resetAstCache());
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkVerifyCore,
  countOccurrences,
  findOccurrences,
  scanOccurrences,
  toList,
} from '../runner/verify-core.mjs';
import { checkVerify } from '../runner/runner.mjs';
import { verifyBatch } from '../runner/verify-batch.mjs';

describe('verify-core — toList', () => {
  it('wraps scalars, passes arrays, empties null/undefined', () => {
    assert.deepEqual(toList('x'), ['x']);
    assert.deepEqual(toList(['a', 'b']), ['a', 'b']);
    assert.deepEqual(toList(undefined), []);
    assert.deepEqual(toList(null), []);
  });
});

describe('verify-core — countOccurrences', () => {
  it('counts non-overlapping occurrences', () => {
    assert.equal(countOccurrences('aaa', 'a'), 3);
    assert.equal(countOccurrences('ababab', 'ab'), 3);
    assert.equal(countOccurrences('xyz', 'q'), 0);
  });
  it('returns 0 for empty needle', () => {
    assert.equal(countOccurrences('abc', ''), 0);
  });
});

describe('verify-core — findOccurrences (matching kernel)', () => {
  it('records non-overlapping, leftmost-first offsets', () => {
    assert.deepEqual(findOccurrences('ababab', 'ab'), [0, 2, 4]);
    assert.deepEqual(findOccurrences('aaa', 'aa'), [0]); // NOT [0, 1]
    assert.deepEqual(findOccurrences('xyz', 'q'), []);
    assert.deepEqual(findOccurrences('abc', ''), []);
  });
  it('countOccurrences is the kernel’s length', () => {
    assert.equal(countOccurrences('aaa', 'aa'), findOccurrences('aaa', 'aa').length);
  });
});

describe('verify-core — scanOccurrences (multi-literal kernel)', () => {
  // For EVERY literal, the multi-literal scan must agree with the per-literal
  // kernel: scanOccurrences(code, lits).get(lit) === findOccurrences(code, lit).
  function assertScanMatchesKernel(code, literals) {
    const positions = scanOccurrences(code, literals);
    for (const lit of literals) {
      assert.deepEqual(
        positions.get(lit),
        findOccurrences(code, lit),
        `offset mismatch for literal ${JSON.stringify(lit)}`,
      );
    }
  }

  it('matches the kernel on the fast path (small sets)', () => {
    assertScanMatchesKernel('alpha beta alpha gamma beta beta', ['alpha', 'beta', 'zzz', 'a', '']);
  });

  it('matches the kernel on the bucketed walk (>64 literals), incl. self-overlap and unicode', () => {
    const code = 'aaaa λλλλ ✓abc✓abc ababab '.repeat(20);
    const literals = ['aa', 'aaa', 'ab', 'abab', 'λλ', '✓abc', 'a', '✓', 'zz'];
    for (let i = 0; i < 70; i++) literals.push(`lit-${i}-nomatch`);
    assert.ok(literals.length > 64);
    assertScanMatchesKernel(code, literals);
  });

  it('dedupes duplicate literals and tolerates empty input', () => {
    const positions = scanOccurrences('abab', ['ab', 'ab']);
    assert.deepEqual(positions.get('ab'), [0, 2]);
    assert.deepEqual([...scanOccurrences('abab', []).keys()], []);
  });
});

describe('verify-core — checkVerifyCore present/absent (default style)', () => {
  it('passes when present found and absent missing', () => {
    const issues = checkVerifyCore({ present: 'foo', absent: 'bar' }, 'a foo b');
    assert.deepEqual(issues, []);
  });
  it('flags missing present with default prefix', () => {
    const issues = checkVerifyCore({ present: 'missing' }, 'nothing here');
    assert.deepEqual(issues, ['expected present: missing']);
  });
  it('flags lingering absent with default prefix', () => {
    const issues = checkVerifyCore({ absent: 'leak' }, 'a leak b');
    assert.deepEqual(issues, ['expected absent: leak']);
  });
  it('truncates the literal to 60 chars in the message', () => {
    const long = 'z'.repeat(80);
    const issues = checkVerifyCore({ present: long }, 'no match');
    assert.equal(issues[0], `expected present: ${'z'.repeat(60)}`);
  });
});

describe('verify-core — checkVerifyCore present/absent (local style)', () => {
  it('uses local prefixes', () => {
    assert.deepEqual(
      checkVerifyCore({ present: 'missing' }, 'x', { style: 'local' }),
      ['verify.present missing: missing'],
    );
    assert.deepEqual(
      checkVerifyCore({ absent: 'leak' }, 'a leak b', { style: 'local' }),
      ['verify.absent still present: leak'],
    );
  });
});

describe('verify-core — count assertions', () => {
  it('count as number means present total', () => {
    assert.deepEqual(checkVerifyCore({ present: 'ab', count: 3 }, 'ababab'), []);
    assert.deepEqual(
      checkVerifyCore({ present: 'ab', count: 2 }, 'ababab'),
      ['expected count.present=2, actual=3 (across 1 string(s))'],
    );
  });
  it('count object with present and absent', () => {
    const issues = checkVerifyCore(
      { present: 'x', count: { present: 2, absent: 3 } },
      'x x',
    );
    // present x=2 ok; no absent literals so absent total=0 != 3.
    assert.deepEqual(issues, ['expected count.absent=3, actual=0 (across 0 string(s))']);
  });
  it('local style count omits the across suffix', () => {
    assert.deepEqual(
      checkVerifyCore({ present: 'ab', count: 2 }, 'ababab', { style: 'local' }),
      ['expected count.present=2, actual=3'],
    );
    assert.deepEqual(
      checkVerifyCore({ count: { absent: 5 } }, 'q q', { style: 'local' }),
      ['expected count.absent=5, actual=0'],
    );
  });
  it('sums counts across multiple present strings', () => {
    assert.deepEqual(
      checkVerifyCore({ present: ['a', 'b'], count: { present: 4 } }, 'a a b b'),
      [],
    );
  });
});

describe('verify-core — positions Map vs indexOf equivalence', () => {
  const code = 'alpha beta alpha gamma beta beta';
  const verify = { present: ['alpha', 'beta'], absent: 'zzz', count: { present: 5 } };

  it('produces identical issues with and without a positions Map', () => {
    // Build positions the same way verify-batch would (offsets per literal).
    const positions = new Map();
    for (const lit of ['alpha', 'beta', 'zzz']) {
      const list = [];
      let i = 0;
      while ((i = code.indexOf(lit, i)) !== -1) { list.push(i); i += lit.length; }
      positions.set(lit, list);
    }
    const withMap = checkVerifyCore(verify, code, { positions });
    const withScan = checkVerifyCore(verify, code, {});
    assert.deepEqual(withMap, withScan);
    // 2 alpha + 3 beta = 5 -> count passes; all present found; absent clean.
    assert.deepEqual(withMap, []);
  });

  it('count mismatch reported identically through both paths', () => {
    const v = { present: ['alpha', 'beta'], count: { present: 99 } };
    const positions = new Map([
      ['alpha', [0, 11]],
      ['beta', [6, 23, 28]],
    ]);
    assert.deepEqual(
      checkVerifyCore(v, code, { positions }),
      checkVerifyCore(v, code, {}),
    );
  });
});

describe('verify-core — delegation parity with public wrappers', () => {
  const code = 'function foo() { return bar; }';

  it('runner checkVerify matches the default-style primitive', () => {
    const v = { present: 'foo', absent: 'baz', count: { present: 1 } };
    assert.deepEqual(checkVerify(v, code), checkVerifyCore(v, code, { style: 'default' }));
  });

  it('verifyBatch matches the primitive per item (issue strings byte-identical)', () => {
    const items = [
      { patchName: 'p1', present: 'foo', absent: 'nope' },
      { patchName: 'p2', present: 'bar', count: 1 },
      { patchName: 'p3', present: 'missing-literal' },
    ];
    const batch = verifyBatch(code, items);
    assert.equal(batch.length, 3);
    assert.deepEqual(batch[0], { name: 'p1', issues: [] });
    assert.deepEqual(batch[1], { name: 'p2', issues: [] });
    assert.deepEqual(batch[2], {
      name: 'p3',
      issues: ['expected present: missing-literal'],
    });
  });

  it('verifyBatch count mismatch keeps the (across K string(s)) suffix', () => {
    const items = [{ patchName: 'p', present: 'o', count: 5 }];
    const batch = verifyBatch('foo boo', items);
    // 'o' occurs 4 times, expected 5
    assert.deepEqual(batch[0].issues, [
      'expected count.present=5, actual=4 (across 1 string(s))',
    ]);
  });
});

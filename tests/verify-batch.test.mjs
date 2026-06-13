import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { verifyBatch } from '../runner/verify-batch.mjs';
import { checkVerifyCore } from '../runner/verify-core.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CODE = 'function foo() { return bar; } function baz() { return qux; }';

/**
 * Run `verifyBatch` and `checkVerifyCore` for the same item, asserting that
 * the issue arrays are identical. Returns the verifyBatch result for the item.
 */
function assertParity(code, item) {
  const batchResult = verifyBatch(code, [item])[0];
  const coreIssues = checkVerifyCore(
    { present: item.present, absent: item.absent, count: item.count },
    code,
    { style: 'default' },
  );
  assert.deepEqual(
    batchResult.issues,
    coreIssues,
    `issue mismatch for patch "${item.patchName}":\n  batch=${JSON.stringify(batchResult.issues)}\n  core=${JSON.stringify(coreIssues)}`,
  );
  return batchResult;
}

// ---------------------------------------------------------------------------
// Basic single-item semantics
// ---------------------------------------------------------------------------

describe('verifyBatch — present checks', () => {
  it('passes when present literal found', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', present: 'foo' }]);
    assert.deepEqual(r, [{ name: 'p', issues: [] }]);
  });

  it('fails when present literal missing', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', present: 'MISSING' }]);
    assert.deepEqual(r[0].issues, ['expected present: MISSING']);
  });

  it('passes when ALL present literals found', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', present: ['foo', 'baz'] }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('fails when any present literal missing', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', present: ['foo', 'NOPE'] }]);
    assert.equal(r[0].issues.length, 1);
    assert.ok(r[0].issues[0].includes('NOPE'));
  });
});

describe('verifyBatch — absent checks', () => {
  it('passes when absent literal not found', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', absent: 'NOTHERE' }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('fails when absent literal IS present', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', absent: 'foo' }]);
    assert.deepEqual(r[0].issues, ['expected absent: foo']);
  });

  it('fails for each lingering absent literal', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', absent: ['foo', 'baz'] }]);
    assert.equal(r[0].issues.length, 2);
  });
});

describe('verifyBatch — count checks (number form)', () => {
  it('passes when exact count matches', () => {
    // 'return' occurs twice in CODE.
    const r = verifyBatch(CODE, [{ patchName: 'p', present: 'return', count: 2 }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('fails when count mismatches', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', present: 'return', count: 99 }]);
    assert.equal(r[0].issues.length, 1);
    assert.ok(r[0].issues[0].includes('count.present=99'));
  });

  it('issue string includes (across K string(s)) suffix', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p', present: 'return', count: 99 }]);
    assert.ok(r[0].issues[0].includes('(across 1 string(s))'));
  });
});

describe('verifyBatch — count checks (object form)', () => {
  it('passes with { present: N }', () => {
    const r = verifyBatch(CODE, [{
      patchName: 'p', present: 'return', count: { present: 2 },
    }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('fails with { present: wrong }', () => {
    const r = verifyBatch(CODE, [{
      patchName: 'p', present: 'return', count: { present: 1 },
    }]);
    assert.ok(r[0].issues[0].includes('count.present=1'));
  });

  it('passes with { absent: 0 } when no absent literals', () => {
    const r = verifyBatch(CODE, [{
      patchName: 'p', present: 'foo', count: { absent: 0 },
    }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('fails with { absent: N } when absent literal is found', () => {
    const r = verifyBatch(CODE, [{
      patchName: 'p', absent: 'foo', count: { absent: 0 },
    }]);
    // 'foo' IS present in CODE, so absent count is 1, not 0.
    assert.ok(r[0].issues.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Multi-item (batched) semantics
// ---------------------------------------------------------------------------

describe('verifyBatch — multi-item batch', () => {
  it('returns one result per item in the same order', () => {
    const items = [
      { patchName: 'a', present: 'foo' },
      { patchName: 'b', present: 'MISSING' },
      { patchName: 'c', absent: 'GONE' },
    ];
    const results = verifyBatch(CODE, items);
    assert.equal(results.length, 3);
    assert.equal(results[0].name, 'a');
    assert.equal(results[1].name, 'b');
    assert.equal(results[2].name, 'c');
    assert.deepEqual(results[0].issues, []);
    assert.ok(results[1].issues.length > 0);
    assert.deepEqual(results[2].issues, []);
  });

  it('each result is independent (one item failing does not affect others)', () => {
    const items = [
      { patchName: 'x', present: 'NOPE' },   // fails
      { patchName: 'y', present: 'foo' },     // passes
    ];
    const [rx, ry] = verifyBatch(CODE, items);
    assert.ok(rx.issues.length > 0);
    assert.deepEqual(ry.issues, []);
  });

  it('handles 0 items gracefully', () => {
    const results = verifyBatch(CODE, []);
    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// Parity with checkVerifyCore (byte-identical issue strings)
// ---------------------------------------------------------------------------

describe('verifyBatch — parity with checkVerifyCore', () => {
  const cases = [
    { present: 'foo', absent: 'NOPE' },
    { present: ['foo', 'bar'] },
    { present: 'return', count: 2 },
    { present: 'return', count: { present: 2 } },
    { absent: 'GONE', count: { absent: 0 } },
    { present: 'MISSING' },
    { absent: 'foo' },
    { present: 'return', count: 99 },
    { present: ['foo', 'baz'], count: { present: 2 } },
  ];

  for (const verify of cases) {
    it(`parity: ${JSON.stringify(verify)}`, () => {
      assertParity(CODE, { patchName: 'test', ...verify });
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('verifyBatch — edge cases', () => {
  it('empty string present is ignored (not an assertion)', () => {
    // An empty-string present is a manifest placeholder; verifyBatch must not
    // flag it as a failure.
    const r = verifyBatch(CODE, [{ patchName: 'p', present: '' }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('handles code that is shorter than SAMPLE_BYTES (short bundles)', () => {
    const short = 'const x = 1;';
    const r = verifyBatch(short, [{ patchName: 'p', present: 'x' }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('long present literal (>60 chars) is truncated in the issue string', () => {
    const needle = 'z'.repeat(80);
    const r = verifyBatch('no match here', [{ patchName: 'p', present: needle }]);
    assert.ok(r[0].issues[0].includes('z'.repeat(60)));
    assert.ok(!r[0].issues[0].includes('z'.repeat(61)));
  });

  it('items with no verify fields produce no issues', () => {
    const r = verifyBatch(CODE, [{ patchName: 'p' }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('count on absent: 0 passes when absent literal is absent from code', () => {
    const r = verifyBatch('hello world', [{
      patchName: 'p', absent: 'NOPE', count: { absent: 0 },
    }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('multiple present strings summed for count', () => {
    // CODE has 'return' twice and 'function' twice → total present count = 4.
    const r = verifyBatch(CODE, [{
      patchName: 'p',
      present: ['return', 'function'],
      count: { present: 4 },
    }]);
    assert.deepEqual(r[0].issues, []);
  });

  it('self-overlapping literal counts agree with the core kernel (non-overlapping)', () => {
    // 'aa' in 'aaa' is ONE non-overlapping occurrence. The pre-dedup batch
    // scan recorded overlapping matches (2) and diverged from checkVerifyCore;
    // both now compose the same kernel.
    const item = { patchName: 'p', present: 'aa', count: 1 };
    assertParity('aaa', item);
    assert.deepEqual(verifyBatch('aaa', [item])[0].issues, []);
  });
});

// ---------------------------------------------------------------------------
// Property-style parity: core vs batch over synthetic cases
// ---------------------------------------------------------------------------
//
// The architecture invariant is that verifyBatch (positions-Map path) and
// checkVerifyCore (direct-scan path) produce IDENTICAL issue arrays for the
// same item — both compose the same non-overlapping matching kernel. These
// cases are built to exercise every kernel path:
//   - small literal sets (fast path: per-literal findOccurrences)
//   - >64 unique literals (the bucketed single-pass walk)
//   - self-overlapping literals ('aa', 'abab', repeated-char runs)
//   - short (<2 char) literals (un-bucketed indexOf path)
//   - non-Latin-1 literals (the *65536 prefix keying)
//   - empty / missing / mixed present+absent+count blocks

describe('verifyBatch — property parity with checkVerifyCore', () => {
  // Deterministic PRNG (mulberry32) so failures reproduce.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function synthCase(seed, literalCount) {
    const rand = rng(seed);
    // Small alphabet → literals repeat and self-overlap inside the code.
    const alphabet = 'abcλ✓\n ';
    const pick = (s) => s[Math.floor(rand() * s.length)];
    let code = '';
    const codeLen = 200 + Math.floor(rand() * 400);
    for (let i = 0; i < codeLen; i++) code += pick(alphabet);

    const literals = [];
    for (let i = 0; i < literalCount; i++) {
      const len = 1 + Math.floor(rand() * 6);
      let lit = '';
      // Half the literals are slices of the code (guaranteed hits), half are
      // random (mostly misses).
      if (rand() < 0.5 && code.length > len) {
        const at = Math.floor(rand() * (code.length - len));
        lit = code.slice(at, at + len);
      } else {
        for (let j = 0; j < len; j++) lit += pick(alphabet);
      }
      // Suffix a discriminator on a few so the literal set stays large enough
      // to force the bucketed walk when literalCount > 64.
      if (rand() < 0.3) lit += `#${i}`;
      literals.push(lit);
    }

    const items = [];
    for (let i = 0; i < literals.length; i++) {
      const item = { patchName: `p${i}` };
      const roll = rand();
      if (roll < 0.45) item.present = literals[i];
      else if (roll < 0.7) item.absent = literals[i];
      else {
        item.present = [literals[i], literals[(i + 7) % literals.length]];
        item.absent = literals[(i + 13) % literals.length];
      }
      const countRoll = rand();
      if (countRoll < 0.25) item.count = Math.floor(rand() * 4);
      else if (countRoll < 0.4) {
        item.count = { present: Math.floor(rand() * 4), absent: Math.floor(rand() * 2) };
      }
      items.push(item);
    }
    return { code, items };
  }

  function assertCaseParity({ code, items }, label) {
    const batch = verifyBatch(code, items);
    assert.equal(batch.length, items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const core = checkVerifyCore(
        { present: it.present, absent: it.absent, count: it.count },
        code,
        { style: 'default' },
      );
      assert.deepEqual(
        batch[i].issues,
        core,
        `${label} item ${i} (${JSON.stringify(it)}):\n  batch=${JSON.stringify(batch[i].issues)}\n  core=${JSON.stringify(core)}`,
      );
    }
  }

  it('parity holds on the fast path (small literal sets)', () => {
    for (const seed of [1, 2, 3, 42, 1337]) {
      assertCaseParity(synthCase(seed, 8), `seed=${seed}`);
    }
  });

  it('parity holds on the bucketed-walk path (>64 unique literals)', () => {
    for (const seed of [7, 99, 2026]) {
      assertCaseParity(synthCase(seed, 90), `seed=${seed}`);
    }
  });

  it('parity holds for crafted self-overlapping / repeated-run literals', () => {
    const code = 'aaaa abab ababab λλλλ ✓✓✓ \n\n\n aaaa';
    const items = [
      { patchName: 'p0', present: 'aa', count: 4 },
      { patchName: 'p1', present: 'aaa', count: 2 },
      { patchName: 'p2', present: 'abab', count: 2 },
      { patchName: 'p3', present: 'λλ', count: 2 },
      { patchName: 'p4', absent: '✓✓', count: { absent: 1 } },
      { patchName: 'p5', present: ['aa', 'abab'], count: { present: 6 } },
      { patchName: 'p6', present: 'a', count: 12 },
      { patchName: 'p7', absent: 'zz' },
    ];
    assertCaseParity({ code, items }, 'crafted');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectFindings, runLint } from '../scripts/lint-contracts.mjs';

describe('lint-contracts — collectFindings', () => {
  it('passes a producer that registers a contract for its cross-patch global', () => {
    const sources = {
      good: 'globalThis.__ccpThing = {}; globalThis.__ccpProvide("thing", { value: globalThis.__ccpThing });',
    };
    assert.deepEqual(collectFindings(sources), []);
  });

  it('flags a producer that writes a cross-patch global with no __ccpProvide', () => {
    const out = collectFindings({ mypatch: 'globalThis.__ccpTotallyNew = 5;' });
    assert.equal(out.length, 1);
    assert.match(out[0], /patch 'mypatch' writes cross-patch global 'globalThis\.__ccpTotallyNew'/);
    assert.match(out[0], /__ccpProvide/);
    assert.match(out[0], /ALLOWLIST/);
  });

  it('does not flag a consumer that only probes a global (=== comparison)', () => {
    const sources = {
      consumer: "if (typeof globalThis.__ccpOnFetch === 'function') globalThis.__ccpOnFetch('x', () => {});",
    };
    assert.deepEqual(collectFindings(sources), []);
  });

  it('does not flag a patch whose only writes are allowlisted', () => {
    assert.deepEqual(collectFindings({ a: 'globalThis.__ccpBootBuf = [];' }), []);
  });

  it('matches the minified `globalThis.__ccpX=` (no space) write form', () => {
    const out = collectFindings({ mini: 'globalThis.__ccpMiniGlobal=fn;' });
    assert.equal(out.length, 1);
    assert.match(out[0], /__ccpMiniGlobal/);
  });

  it('a single __ccpProvide exempts every global the patch writes (per-patch rule)', () => {
    const sources = {
      multi:
        'globalThis.__ccpAlpha = 1; globalThis.__ccpBeta = 2;' +
        'globalThis.__ccpProvide("alpha", { value: globalThis.__ccpAlpha });',
    };
    assert.deepEqual(collectFindings(sources), []);
  });
});

describe('lint-contracts — real repo', () => {
  it('the corpus satisfies the rule (exit 0)', async () => {
    const origLog = console.log;
    const origError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      assert.equal(await runLint(), 0);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });
});

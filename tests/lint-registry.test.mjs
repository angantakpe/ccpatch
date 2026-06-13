import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectFindings, runLint } from '../scripts/lint-registry.mjs';

// Synthetic corpus: two loaded patches, one with capabilities + dependsOn.
const PATCHES = {
  alpha: { capabilities: ['network'], dependsOn: ['beta'] },
  beta: { capabilities: [] },
};
const FLAGS = { alpha: true, beta: false };

describe('lint-registry — collectFindings', () => {
  it('passes a consistent registry', () => {
    assert.deepEqual(collectFindings(PATCHES, FLAGS, { alpha: ['network'] }), []);
  });

  it('flags a patches: entry with no patch file', () => {
    const out = collectFindings(PATCHES, { ...FLAGS, ghost: true }, {});
    assert.equal(out.length, 1);
    assert.match(out[0], /'ghost' does not match any patch file/);
  });

  it('flags a patch file with no patches: entry', () => {
    const out = collectFindings(PATCHES, { alpha: true }, {});
    assert.equal(out.length, 1);
    assert.match(out[0], /'beta\.mjs' has no ccpatch\.yml patches: entry/);
  });

  it('flags an ack for an unregistered patch', () => {
    const out = collectFindings(PATCHES, FLAGS, { ghost: ['network'] });
    assert.ok(out.some(m => /ack: entry 'ghost'/.test(m)));
  });

  it('flags an ack naming an unknown capability', () => {
    const out = collectFindings(PATCHES, FLAGS, { alpha: ['warp-drive'] });
    assert.ok(out.some(m => /unknown capability 'warp-drive'/.test(m)));
  });

  it('flags an ack for a capability the patch does not declare', () => {
    const out = collectFindings(PATCHES, FLAGS, { beta: ['exec'] });
    assert.ok(out.some(m => /'beta' acknowledges 'exec' but the patch does not declare it/.test(m)));
  });

  it('accepts a blanket * ack', () => {
    assert.deepEqual(collectFindings(PATCHES, FLAGS, { beta: ['*'] }), []);
  });

  it('flags a dependsOn target that is not a loaded patch', () => {
    const patches = { alpha: { dependsOn: ['missing_dep'] } };
    const out = collectFindings(patches, { alpha: true }, {});
    assert.ok(out.some(m => /dependsOn 'missing_dep'/.test(m)));
  });
});

describe('lint-registry — real repo', () => {
  it('passes on the current repo state (legacy cases warn, not fail)', async () => {
    // Silence the OK/WARN chatter; we only assert the exit code.
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      assert.equal(await runLint(), 0);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  });
});

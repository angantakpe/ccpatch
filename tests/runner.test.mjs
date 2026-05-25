import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyNamedPatches, topoSort } from '../runner/runner.mjs';

const silent = { log() {}, warn() {}, error() {} };

function mkPatch({ description = 'test', apply, verify, required, dependsOn } = {}) {
  const p = {
    description,
    apply: apply ?? ((c) => c + ' '),
    verify: verify ?? { present: '' },
  };
  if (required) p.required = required;
  if (dependsOn) p.dependsOn = dependsOn;
  return p;
}

describe('topoSort', () => {
  it('orders simple chain by dependsOn', () => {
    const patches = {
      a: mkPatch(),
      b: mkPatch({ dependsOn: ['a'] }),
      c: mkPatch({ dependsOn: ['b'] }),
    };
    assert.deepEqual(topoSort(['c', 'b', 'a'], patches), ['a', 'b', 'c']);
  });

  it('throws on unknown dependsOn (typo)', () => {
    const patches = { a: mkPatch({ dependsOn: ['ghost'] }) };
    assert.throws(
      () => topoSort(['a'], patches),
      /declares dependsOn "ghost".*no such patch is loaded/,
    );
  });

  it('throws when dep exists on disk but is not enabled', () => {
    const patches = {
      foundation: mkPatch(),
      extension: mkPatch({ dependsOn: ['foundation'] }),
    };
    assert.throws(
      () => topoSort(['extension'], patches),
      /requires "foundation".*not enabled/,
    );
  });

  it('throws on circular dependency', () => {
    const patches = {
      a: mkPatch({ dependsOn: ['b'] }),
      b: mkPatch({ dependsOn: ['a'] }),
    };
    assert.throws(
      () => topoSort(['a', 'b'], patches),
      /Circular patch dependency/,
    );
  });
});

describe('applyNamedPatches — non-strict (default)', () => {
  it('warns but does not throw on no-change', async () => {
    const patches = { noop: mkPatch({ apply: (c) => c }) };
    const out = await applyNamedPatches('hello', patches, ['noop'], silent);
    assert.equal(out, 'hello');
  });

  it('swallows apply() errors and continues', async () => {
    const patches = {
      bad:  mkPatch({ apply: () => { throw new Error('boom'); } }),
      good: mkPatch({ apply: (c) => c + '+good' }),
    };
    const out = await applyNamedPatches('x', patches, ['bad', 'good'], silent);
    assert.equal(out, 'x+good');
  });

  it('warns on verify failures but does not throw', async () => {
    const patches = {
      p: { description: 't', apply: (c) => c + '!', verify: { present: 'NOT-THERE' } },
    };
    await assert.doesNotReject(() => applyNamedPatches('x', patches, ['p'], silent));
  });
});

describe('applyNamedPatches — strict mode', () => {
  const opts = { strict: true };

  it('throws on no-change', async () => {
    const patches = { noop: mkPatch({ apply: (c) => c }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['noop'], silent, opts),
      /strict mode[\s\S]*no-change/,
    );
  });

  it('throws when apply() returns non-string', async () => {
    const patches = { weird: mkPatch({ apply: () => 42 }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['weird'], silent, opts),
      /non-string/,
    );
  });

  it('throws when apply() throws', async () => {
    const patches = { bad: mkPatch({ apply: () => { throw new Error('boom'); } }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['bad'], silent, opts),
      /apply\(\) threw: boom/,
    );
  });

  it('throws on verify.present miss', async () => {
    const patches = {
      p: { description: 't', apply: (c) => c + '!', verify: { present: 'NOT-THERE' } },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], silent, opts),
      /verify.*present.*NOT-THERE/,
    );
  });

  it('throws on verify.absent hit', async () => {
    const patches = {
      p: { description: 't', apply: (c) => c + 'FORBIDDEN', verify: { absent: 'FORBIDDEN' } },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], silent, opts),
      /verify.*absent.*FORBIDDEN/,
    );
  });

  it('aggregates multiple failures into one error', async () => {
    const patches = {
      a: mkPatch({ apply: (c) => c }),
      b: mkPatch({ apply: () => { throw new Error('nope'); } }),
    };
    let err;
    try { await applyNamedPatches('x', patches, ['a', 'b'], silent, opts); }
    catch (e) { err = e; }
    assert.ok(err, 'expected throw');
    assert.match(err.message, /2 patch failure\(s\)/);
    assert.match(err.message, /a: no-change/);
    assert.match(err.message, /b: apply\(\) threw/);
  });

  it('passes when every patch applies cleanly', async () => {
    const patches = {
      a: { ...mkPatch({ apply: (c) => c + '1' }), allowOverlapWith: ['b'] },
      b: { ...mkPatch({ apply: (c) => c + '2' }), allowOverlapWith: ['a'] },
    };
    const out = await applyNamedPatches('x', patches, ['a', 'b'], silent, opts);
    assert.equal(out, 'x12');
  });
});

describe('applyNamedPatches — required: true (per-patch strict)', () => {
  it('throws on no-change for required patch even without global strict', async () => {
    const patches = { core: mkPatch({ apply: (c) => c, required: true }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['core'], silent),
      /required patches[\s\S]*no-change/,
    );
  });

  it('non-required patches still skipped silently when required passes', async () => {
    const patches = {
      core: mkPatch({ apply: (c) => c + '+core', required: true }),
      opt:  mkPatch({ apply: (c) => c }),
    };
    const out = await applyNamedPatches('x', patches, ['core', 'opt'], silent);
    assert.equal(out, 'x+core');
  });
});

describe('applyNamedPatches — revisit markers', () => {
  function mkLogger() {
    const warnings = [];
    return {
      warnings,
      log() {},
      warn(msg) { warnings.push(msg); },
      error() {},
    };
  }

  it('emits [revisit] warning when bundle version >= revisit.until', async () => {
    const patches = {
      forensic: {
        ...mkPatch({ apply: (c) => c + '+f' }),
        revisit: { note: 'check normalizer', addedIn: '2.1.131', until: '2.1.148' },
      },
    };
    const logger = mkLogger();
    await applyNamedPatches('x', patches, ['forensic'], logger, { version: '2.1.148' });
    assert.ok(
      logger.warnings.some(w => w.includes('[revisit] forensic') && w.includes('2.1.148')),
      `expected revisit warning, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('does not warn when bundle version < revisit.until', async () => {
    const patches = {
      forensic: {
        ...mkPatch({ apply: (c) => c + '+f' }),
        revisit: { note: 'x', until: '2.2.0' },
      },
    };
    const logger = mkLogger();
    await applyNamedPatches('x', patches, ['forensic'], logger, { version: '2.1.148' });
    assert.ok(
      !logger.warnings.some(w => w.includes('[revisit]')),
      `unexpected revisit warning: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('does not warn when patchOptions.version is missing', async () => {
    const patches = {
      forensic: {
        ...mkPatch({ apply: (c) => c + '+f' }),
        revisit: { note: 'x', until: '2.1.148' },
      },
    };
    const logger = mkLogger();
    await applyNamedPatches('x', patches, ['forensic'], logger);
    assert.ok(
      !logger.warnings.some(w => w.includes('[revisit]')),
      `unexpected revisit warning: ${JSON.stringify(logger.warnings)}`,
    );
  });
});

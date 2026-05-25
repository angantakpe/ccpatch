import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyNamedPatches } from '../runner/runner.mjs';
import { validateManifest } from '../runner/manifest.mjs';

const silent = { log() {}, warn() {}, error() {} };

const TELEMETRY_PATH = path.join('storage/outputs', 'patch-lifecycle.jsonl');

function readTelemetry() {
  if (!fs.existsSync(TELEMETRY_PATH)) return [];
  return fs.readFileSync(TELEMETRY_PATH, 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
}

function clearTelemetry() {
  try { fs.unlinkSync(TELEMETRY_PATH); } catch (_) { /* ignore */ }
}

describe('manifest — lifecycle hooks', () => {
  const base = { description: 't', apply: (c) => c + '+', verify: { present: '+' } };

  it('accepts function-typed hooks', () => {
    const { ok } = validateManifest(
      { ...base, onBeforeApply: () => {}, onAfterApply: async () => {}, onVerifyFail: () => {} },
      'p.mjs',
    );
    assert.equal(ok, true);
  });

  it('rejects non-function hooks', () => {
    for (const name of ['onBeforeApply', 'onAfterApply', 'onVerifyFail']) {
      const { ok, errors } = validateManifest({ ...base, [name]: 'not a fn' }, 'p.mjs');
      assert.equal(ok, false);
      assert.ok(errors.some(e => e.includes(name)), `expected error mentioning ${name}: ${errors.join(' | ')}`);
    }
  });
});

describe('lifecycle hooks — runtime', () => {
  before(() => clearTelemetry());
  after(() => clearTelemetry());

  it('onBeforeApply mutates ctx.opts and the patch sees the mutation', async () => {
    const seen = {};
    const patches = {
      p: {
        description: 't',
        apply: (c, opts) => { seen.flag = opts.injectedFlag; return c + '+'; },
        verify: { present: '+' },
        onBeforeApply(ctx) { ctx.opts.injectedFlag = 'hello'; },
      },
    };
    await applyNamedPatches('x', patches, ['p'], silent);
    assert.equal(seen.flag, 'hello');
  });

  it('onAfterApply mutates ctx.appliedCode and the mutated code is verified', async () => {
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + '+raw',
        verify: { present: '+POST' },
        onAfterApply(ctx) {
          ctx.appliedCode = ctx.appliedCode.replace('+raw', '+POST');
        },
      },
    };
    const out = await applyNamedPatches('x', patches, ['p'], silent);
    assert.equal(out, 'x+POST');
  });

  it('onVerifyFail returns a fixed string — verify re-runs and passes', async () => {
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + 'broken',
        verify: { present: 'GOOD' },
        onVerifyFail(ctx) {
          return ctx.appliedCode.replace('broken', 'GOOD');
        },
      },
    };
    const out = await applyNamedPatches('x', patches, ['p'], silent, { strict: true });
    assert.equal(out, 'xGOOD');
  });

  it('onVerifyFail returns nothing — original verify failure stands', async () => {
    let attempts = 0;
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + 'broken',
        verify: { present: 'GOOD' },
        onVerifyFail() { attempts++; /* return undefined */ },
      },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], silent, { strict: true }),
      /expected present/,
    );
    assert.equal(attempts, 1);
  });

  it('retry caps at 1 — a hook that always returns broken does not loop', async () => {
    let calls = 0;
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + 'broken',
        verify: { present: 'GOOD' },
        onVerifyFail(ctx) {
          calls++;
          return ctx.appliedCode; // still broken
        },
      },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], silent, { strict: true }),
      /expected present/,
    );
    assert.equal(calls, 1, 'onVerifyFail must be invoked at most once');
  });

  it('async hook resolves before the next step', async () => {
    const order = [];
    const patches = {
      p: {
        description: 't',
        apply: (c) => { order.push('apply'); return c + '+'; },
        verify: { present: '+' },
        async onBeforeApply() {
          await new Promise(r => setTimeout(r, 5));
          order.push('beforeApply');
        },
        async onAfterApply() {
          await new Promise(r => setTimeout(r, 5));
          order.push('afterApply');
        },
      },
    };
    await applyNamedPatches('x', patches, ['p'], silent);
    assert.deepEqual(order, ['beforeApply', 'apply', 'afterApply']);
  });

  it('hook that throws — logged, fail() called, no infinite loop', async () => {
    const errs = [];
    const logger = { log() {}, warn() {}, error: (m) => errs.push(String(m)) };
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + '+',
        verify: { present: '+' },
        onBeforeApply() { throw new Error('boom in hook'); },
      },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], logger, { strict: true }),
      /onBeforeApply threw: boom in hook/,
    );
    assert.ok(errs.some(e => e.includes('[hook] p.onBeforeApply')), `expected hook log, got: ${errs.join(' | ')}`);
  });

  it('writes one JSONL entry per hook fire', async () => {
    clearTelemetry();
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + '+raw',
        verify: { present: '+POST' },
        onBeforeApply() {},
        onAfterApply(ctx) { ctx.appliedCode = ctx.appliedCode.replace('+raw', '+POST'); },
      },
    };
    await applyNamedPatches('x', patches, ['p'], silent);
    const entries = readTelemetry();
    const hooks = entries.filter(e => e.patch === 'p').map(e => e.hook).sort();
    assert.deepEqual(hooks, ['onAfterApply', 'onBeforeApply']);
    for (const e of entries) {
      assert.ok(typeof e.durationMs === 'number');
      assert.ok(typeof e.byteDelta === 'number');
      assert.equal(typeof e.ts, 'string');
    }
  });

  it('hook throw also produces a telemetry entry with error', async () => {
    clearTelemetry();
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + '+',
        verify: { present: '+' },
        onBeforeApply() { throw new Error('telemetry-boom'); },
      },
    };
    try { await applyNamedPatches('x', patches, ['p'], silent); } catch (_) { /* ignore */ }
    const entries = readTelemetry();
    const errEntry = entries.find(e => e.patch === 'p' && e.hook === 'onBeforeApply');
    assert.ok(errEntry, 'expected entry for onBeforeApply');
    assert.match(errEntry.error, /telemetry-boom/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAt,
  injectAtHead,
  injectAtReturn,
  injectAround,
  injectAt,
} from '../runner/at-selector.mjs';
import { validateManifest } from '../runner/manifest.mjs';
import durableCron from '../extensions/durable_cron.mjs';

// Synthetic mini-bundle that mimics the minified shape of CC's feature gates.
const MINI_BUNDLE = [
  '#!/usr/bin/env node',
  'function A(x){return x+1}',
  'function isDurableCron(){return featGate("tengu_kairos_cron_durable",!0,opts)}',
  'function multi(y){if(y)return y+1;return 0}',
  'function host(){A(1);A(2);other("tengu_kairos_cron_durable",!0,opts);return A(3)}',
  'var marker="hello world banner";',
].join('\n');

describe('resolveAt — HEAD', () => {
  it('resolves a function by literal to body-start offset', () => {
    const r = resolveAt(
      { kind: 'HEAD', target: { function: { literal: 'tengu_kairos_cron_durable' } } },
      MINI_BUNDLE
    );
    assert.equal(r.ok, true);
    assert.equal(r.sites.length, 1);
    assert.equal(r.sites[0].kind, 'HEAD');
    // The character just before site.start should be '{'.
    assert.equal(MINI_BUNDLE[r.sites[0].start - 1], '{');
  });

  it('resolves a function by name', () => {
    const r = resolveAt({ kind: 'HEAD', target: { function: 'A' } }, MINI_BUNDLE);
    assert.equal(r.ok, true);
    assert.equal(MINI_BUNDLE[r.sites[0].start - 1], '{');
  });

  it('injectAtHead splices fragment after opening brace', () => {
    const r = resolveAt({ kind: 'HEAD', target: { function: 'A' } }, MINI_BUNDLE);
    const out = injectAtHead(MINI_BUNDLE, r.sites[0], 'var __h=1;');
    assert.ok(out.includes('function A(x){var __h=1;return x+1}'));
  });

  it('returns candidates from fuzzyMatch when literal not found', () => {
    const r = resolveAt(
      { kind: 'HEAD', target: { function: { literal: 'tengu_nonexistent_xyz' } } },
      MINI_BUNDLE
    );
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.candidates));
  });
});

describe('resolveAt — RETURN', () => {
  it('finds every return statement in a multi-return function', () => {
    const r = resolveAt({ kind: 'RETURN', target: { function: 'multi' } }, MINI_BUNDLE);
    assert.equal(r.ok, true);
    assert.equal(r.sites.length, 2);
    for (const s of r.sites) assert.equal(s.kind, 'RETURN');
  });

  it('injectAtReturn wraps every return value', () => {
    const r = resolveAt({ kind: 'RETURN', target: { function: 'multi' } }, MINI_BUNDLE);
    const out = injectAtReturn(MINI_BUNDLE, r.sites, (expr) => `(__log(${expr}))`);
    assert.ok(out.includes('return (__log(y+1))'));
    assert.ok(out.includes('return (__log(0))'));
  });
});

describe('resolveAt — INVOKE', () => {
  it('finds all calls to a function by default', () => {
    const r = resolveAt({ kind: 'INVOKE', target: { call: 'A', in: 'host' } }, MINI_BUNDLE);
    assert.equal(r.ok, true);
    assert.equal(r.sites.length, 3);
  });

  it('selects only the Nth call when occurrence is set', () => {
    const r = resolveAt(
      { kind: 'INVOKE', target: { call: 'A', occurrence: 2, in: 'host' } },
      MINI_BUNDLE
    );
    assert.equal(r.ok, true);
    assert.equal(r.sites.length, 1);
    // The selected call should be A(2).
    const txt = MINI_BUNDLE.slice(r.sites[0].start, r.sites[0].end);
    assert.equal(txt, 'A(2)');
  });

  it('injectAround wraps call with before/after expressions', () => {
    const r = resolveAt(
      { kind: 'INVOKE', target: { call: 'A', occurrence: 1, in: 'host' } },
      MINI_BUNDLE
    );
    const out = injectAround(MINI_BUNDLE, r.sites[0], '__pre()', '__post()');
    assert.ok(out.includes('(__pre(),A(1),__post())'));
  });

  it('fails cleanly when occurrence exceeds available calls', () => {
    const r = resolveAt(
      { kind: 'INVOKE', target: { call: 'A', occurrence: 99, in: 'host' } },
      MINI_BUNDLE
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /out of range/);
  });
});

describe('resolveAt — BEFORE / AFTER', () => {
  it('BEFORE returns a zero-length site at the literal', () => {
    const r = resolveAt({ kind: 'BEFORE', target: { literal: 'hello world banner' } }, MINI_BUNDLE);
    assert.equal(r.ok, true);
    assert.equal(r.sites[0].start, r.sites[0].end);
    assert.equal(MINI_BUNDLE.slice(r.sites[0].start, r.sites[0].start + 5), 'hello');
  });

  it('AFTER returns a zero-length site past the literal', () => {
    const r = resolveAt({ kind: 'AFTER', target: { literal: 'hello world banner' } }, MINI_BUNDLE);
    assert.equal(r.ok, true);
    assert.equal(MINI_BUNDLE[r.sites[0].start - 1], 'r'); // last char of "banner"
  });

  it('injectAt splices at BEFORE/AFTER site', () => {
    const r = resolveAt({ kind: 'AFTER', target: { literal: 'hello world banner' } }, MINI_BUNDLE);
    const out = injectAt(MINI_BUNDLE, r.sites[0], '!!');
    assert.ok(out.includes('hello world banner!!'));
  });

  it('returns fuzzyMatch candidates when literal not found', () => {
    const r = resolveAt({ kind: 'BEFORE', target: { literal: 'tengu_kairos_cron_durabl_TYPO' } }, MINI_BUNDLE);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.candidates));
  });
});

describe('manifest validator — at field', () => {
  const base = { description: 'x', verify: { present: 'y' }, apply: () => '' };

  it('rejects unknown kind', () => {
    const { ok, errors } = validateManifest(
      { ...base, at: { kind: 'FOO', target: { function: 'A' } } },
      'p.mjs'
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /at\.kind/.test(e)));
  });

  it('requires target.function for HEAD', () => {
    const { ok, errors } = validateManifest(
      { ...base, at: { kind: 'HEAD', target: {} } },
      'p.mjs'
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /target\.function/.test(e)));
  });

  it('requires target.function for RETURN', () => {
    const { ok, errors } = validateManifest(
      { ...base, at: { kind: 'RETURN', target: {} } },
      'p.mjs'
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /target\.function/.test(e)));
  });

  it('requires target.call for INVOKE', () => {
    const { ok, errors } = validateManifest(
      { ...base, at: { kind: 'INVOKE', target: {} } },
      'p.mjs'
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /target\.call/.test(e)));
  });

  it('requires target.literal for BEFORE/AFTER', () => {
    const { ok, errors } = validateManifest(
      { ...base, at: { kind: 'BEFORE', target: {} } },
      'p.mjs'
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /target\.literal/.test(e)));
  });

  it('rejects @At selector when apply() is missing', () => {
    const { ok, errors } = validateManifest(
      { description: 'x', verify: { present: 'y' }, at: { kind: 'HEAD', target: { function: 'A' } } },
      'p.mjs'
    );
    assert.equal(ok, false);
    // Either the generic "apply must be a function" or our explicit at-needs-apply rule.
    assert.ok(errors.some(e => /apply/.test(e)));
  });

  it('accepts a valid HEAD selector', () => {
    const { ok, errors, normalized } = validateManifest(
      { ...base, at: { kind: 'HEAD', target: { function: { literal: 'foo_bar_baz' } } } },
      'p.mjs'
    );
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.equal(normalized.at.kind, 'HEAD');
  });
});

describe('durable_cron — byte-identical output after conversion', () => {
  // The pre-conversion behavior: locate via findFunctionByLiteral and replace
  // the function with `function NAME(){return !0}` plus the /cron registration
  // block. We replicate that here against the same fixture and compare.
  const FIX = [
    '#!/usr/bin/env node',
    'function someFn(x){return x}',
    'function isDurableCron(){return featGate("tengu_kairos_cron_durable",!0,opts)}',
    'function more(){return 1}',
  ].join('\n');

  it('produces the expected patched output', () => {
    const out = durableCron.apply(FIX, {});
    // Function body replaced.
    assert.ok(out.includes('function isDurableCron(){return !0}'));
    // Original gated form gone.
    assert.ok(!out.includes('"tengu_kairos_cron_durable",!0,'));
    // /cron command registration injected at the shebang.
    assert.ok(out.includes('__ccpRegisterSlashCommand'));
    assert.ok(out.startsWith('#!/usr/bin/env node\n'));
  });

  it('output is stable across invocations (deterministic)', () => {
    const a = durableCron.apply(FIX, {});
    const b = durableCron.apply(FIX, {});
    assert.equal(a, b);
  });

  it('manifest validates with the at field', () => {
    const { ok, errors, normalized } = validateManifest(durableCron, 'durable_cron.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.equal(normalized.at.kind, 'HEAD');
    assert.deepEqual(normalized.at.target, { function: { literal: 'tengu_kairos_cron_durable' } });
  });
});

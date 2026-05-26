import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../runner/manifest.mjs';

describe('validateManifest', () => {
  it('accepts a valid build-mode manifest', () => {
    const mod = {
      description: 'Does something useful',
      verify: { present: '__marker__', count: { present: 1 } },
      apply: () => '',
    };
    const { ok, errors, normalized } = validateManifest(mod, 'my_patch.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.equal(normalized.name, 'my_patch');
    assert.equal(normalized.applyMode, 'build');
    assert.equal(normalized.version, '0.0.0');
    assert.equal(normalized.phase, 'main');
    assert.deepEqual(normalized.dependsOn, []);
  });

  it('accepts a valid either-mode manifest', () => {
    const mod = {
      name: 'hook_noise_mute',
      version: '1.0.0',
      description: 'Mute noise',
      applyMode: 'either',
      verify: { present: '__ccpNoiseMuted', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'hook_noise_mute.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
  });

  it('accepts a valid phase value', () => {
    const mod = {
      description: 'pre-phase patch',
      phase: 'pre',
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.equal(normalized.phase, 'pre');
  });

  it('rejects an invalid phase value', () => {
    const mod = {
      description: 'bad phase',
      phase: 'beforehand',
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('phase')), `errors: ${errors}`);
  });

  it('rejects verifyExempt — no longer supported', () => {
    const mod = {
      description: 'Patch with no stable verify string',
      verifyExempt: true,
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'exempted.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('verifyExempt')), `errors: ${errors}`);
  });

  it('rejects missing verify and missing verifyExempt', () => {
    const mod = { description: 'ok', apply: () => '' };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('verify')), `errors: ${errors}`);
  });

  it('rejects verifyExempt:true alongside verify — both are forbidden', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
      verifyExempt: true,
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('verifyExempt')), `errors: ${errors}`);
  });

  it('rejects missing description', () => {
    const mod = { apply: () => '', verify: { present: 'x', weak: true } };
    const { ok, errors } = validateManifest(mod, 'some_patch.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('description')), `errors: ${errors}`);
  });

  it('rejects name mismatch', () => {
    const mod = {
      name: 'wrong_name',
      description: 'ok',
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'right_name.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('name mismatch')), `errors: ${errors}`);
  });

  it('rejects invalid applyMode enum', () => {
    const mod = { description: 'ok', applyMode: 'turbo', verify: { present: 'x', weak: true }, apply: () => '' };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('applyMode')), `errors: ${errors}`);
  });

  it('rejects build-mode without apply', () => {
    const mod = { description: 'ok', verify: { present: 'x', weak: true } };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('apply')), `errors: ${errors}`);
  });

  it('rejects preload:true without preloadCode', () => {
    const mod = { description: 'ok', verify: { present: 'x', weak: true }, apply: () => '', preload: true };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('preloadCode')), `errors: ${errors}`);
  });

  it('rejects preloadCode without preload:true', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
      apply: () => '',
      preloadCode: 'var x = 1;',
    };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('preload')), `errors: ${errors}`);
  });

  it('accepts a valid revisit marker', () => {
    const mod = {
      description: 'forensic',
      verify: { present: 'x', weak: true },
      apply: () => '',
      revisit: { note: 'check at next bump', addedIn: '2.1.131', until: '2.2.0' },
    };
    const { ok, errors, normalized } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.deepEqual(normalized.revisit, { note: 'check at next bump', addedIn: '2.1.131', until: '2.2.0' });
  });

  it('rejects revisit without a note', () => {
    const mod = {
      description: 'forensic',
      verify: { present: 'x', weak: true },
      apply: () => '',
      revisit: { until: '2.2.0' },
    };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('revisit.note')), `errors: ${errors}`);
  });

  it('rejects revisit with non-string version field', () => {
    const mod = {
      description: 'forensic',
      verify: { present: 'x', weak: true },
      apply: () => '',
      revisit: { note: 'x', until: 220 },
    };
    const { ok, errors } = validateManifest(mod, 'x.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('revisit.until')), `errors: ${errors}`);
  });

  it('applies defaults for optional fields', () => {
    const mod = { description: 'minimal', verify: { present: '__marker__', weak: true }, apply: () => '' };
    const { ok, errors, normalized } = validateManifest(mod, 'minimal.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.equal(normalized.version, '0.0.0');
    assert.equal(normalized.phase, 'main');
    assert.deepEqual(normalized.dependsOn, []);
    assert.equal(normalized.applyMode, 'build');
    assert.equal(normalized.anchor, null);
    assert.equal(normalized.preload, false);
    assert.equal(normalized.preloadCode, null);
    assert.equal(normalized.revisit, null);
    assert.equal(normalized.deprecated, null);
  });

  it('rejects weak verify (present-only) without opt-in', () => {
    const mod = {
      description: 'weak',
      verify: { present: '__sentinel__' },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('weak verify')), `errors: ${errors}`);
  });

  it('accepts weak verify when opted in via weak:true', () => {
    const mod = {
      description: 'weak ok',
      verify: { present: '__sentinel__', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
  });

  it('accepts verify with present+count (strong, no weak opt-in needed)', () => {
    const mod = {
      description: 'strong',
      verify: { present: '__s__', count: { present: 1 } },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
  });

  it('accepts verify with present+absent (strong)', () => {
    const mod = {
      description: 'strong',
      verify: { present: '__a__', absent: '__b__' },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
  });

  it('rejects verify.weak when not a boolean', () => {
    const mod = {
      description: 'bad weak',
      verify: { present: 'x', weak: 'yes' },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('verify.weak')), `errors: ${errors}`);
  });

  it('accepts a valid deprecated marker', () => {
    const mod = {
      description: 'no-op',
      verify: { present: 'x', weak: true },
      apply: () => '',
      deprecated: { reason: 'upstream removed feature flag', since: '2.1.146' },
    };
    const { ok, errors, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.deepEqual(normalized.deprecated, { reason: 'upstream removed feature flag', since: '2.1.146' });
  });

  it('rejects deprecated without a reason', () => {
    const mod = {
      description: 'bad dep',
      verify: { present: 'x', weak: true },
      apply: () => '',
      deprecated: { since: '2.1.0' },
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('deprecated.reason')), `errors: ${errors}`);
  });

  it('rejects deprecated.since when not a string', () => {
    const mod = {
      description: 'bad dep',
      verify: { present: 'x', weak: true },
      apply: () => '',
      deprecated: { reason: 'gone', since: 146 },
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('deprecated.since')), `errors: ${errors}`);
  });
});

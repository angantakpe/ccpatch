import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseVariantStem,
  variantMatches,
  pickBestVariant,
  scanVariantDir,
  resolvePatchFile,
} from '../runner/version-resolver.mjs';
import { validateManifest } from '../runner/manifest.mjs';
import { loadPatches } from '../runner/loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'per-version');
const FIXTURE_CORE = path.join(FIXTURE_ROOT, 'core');
const FIXTURE_EXT = path.join(FIXTURE_ROOT, 'extensions');

describe('version-resolver: parseVariantStem', () => {
  it('parses exact versions', () => {
    assert.deepEqual(parseVariantStem('2.1.148'), { kind: 'exact', version: '2.1.148' });
  });
  it('parses >= ranges', () => {
    assert.deepEqual(parseVariantStem('>=2.1.150'), { kind: 'range', gte: '2.1.150' });
  });
  it('parses < ranges', () => {
    assert.deepEqual(parseVariantStem('<2.2.0'), { kind: 'range', lt: '2.2.0' });
  });
  it('parses combined ranges', () => {
    assert.deepEqual(parseVariantStem('>=2.1.150,<2.2.0'), { kind: 'range', gte: '2.1.150', lt: '2.2.0' });
  });
  it('rejects nonsense', () => {
    assert.equal(parseVariantStem('not-a-version'), null);
    assert.equal(parseVariantStem(''), null);
    assert.equal(parseVariantStem('>=foo'), null);
    assert.equal(parseVariantStem('>=2.1.150,>=2.1.160'), null); // duplicate >=
    assert.equal(parseVariantStem('>=2.2.0,<2.1.0'), null);     // inverted
  });
});

describe('version-resolver: variantMatches', () => {
  it('exact matches only exact version', () => {
    const p = parseVariantStem('2.1.148');
    assert.equal(variantMatches(p, '2.1.148'), true);
    assert.equal(variantMatches(p, '2.1.149'), false);
  });
  it('>=X matches X and above', () => {
    const p = parseVariantStem('>=2.1.150');
    assert.equal(variantMatches(p, '2.1.149'), false);
    assert.equal(variantMatches(p, '2.1.150'), true);
    assert.equal(variantMatches(p, '2.1.200'), true);
  });
  it('<X matches strictly below', () => {
    const p = parseVariantStem('<2.1.150');
    assert.equal(variantMatches(p, '2.1.149'), true);
    assert.equal(variantMatches(p, '2.1.150'), false);
  });
  it('combined >=A,<B is half-open', () => {
    const p = parseVariantStem('>=2.1.150,<2.2.0');
    assert.equal(variantMatches(p, '2.1.149'), false);
    assert.equal(variantMatches(p, '2.1.150'), true);
    assert.equal(variantMatches(p, '2.1.999'), true);
    assert.equal(variantMatches(p, '2.2.0'), false);
  });
});

describe('version-resolver: pickBestVariant', () => {
  function v(stem) {
    return { stem, parsed: parseVariantStem(stem), filePath: '/dev/null/' + stem };
  }

  it('picks exact over any range', () => {
    const variants = [v('>=2.1.140'), v('2.1.148'), v('>=2.1.148')];
    const best = pickBestVariant(variants, '2.1.148');
    assert.equal(best.stem, '2.1.148');
  });

  it('picks narrowest range (highest lower bound)', () => {
    const variants = [v('>=2.1.140'), v('>=2.1.150')];
    const best = pickBestVariant(variants, '2.1.150');
    assert.equal(best.stem, '>=2.1.150');
  });

  it('returns null when no variant matches', () => {
    const variants = [v('>=2.2.0')];
    assert.equal(pickBestVariant(variants, '2.1.148'), null);
  });

  it('breaks ties on equal gte by lower lt (narrower window)', () => {
    const variants = [v('>=2.1.150,<2.2.0'), v('>=2.1.150,<3.0.0')];
    const best = pickBestVariant(variants, '2.1.150');
    assert.equal(best.stem, '>=2.1.150,<2.2.0');
  });
});

describe('version-resolver: resolvePatchFile (fixture)', () => {
  it('picks exact match for 2.1.148', () => {
    const r = resolvePatchFile(FIXTURE_CORE, 'example_versioned', '2.1.148');
    assert.match(r.filePath, /example_versioned[\\/]2\.1\.148\.mjs$/);
    assert.equal(r.variant, '2.1.148');
  });

  it('picks >= variant for 2.1.151', () => {
    const r = resolvePatchFile(FIXTURE_CORE, 'example_versioned', '2.1.151');
    assert.equal(r.variant, '>=2.1.150');
  });

  it('falls back to default for 2.1.100', () => {
    const r = resolvePatchFile(FIXTURE_CORE, 'example_versioned', '2.1.100');
    assert.equal(r.variant, 'default');
    assert.match(r.filePath, /example_versioned\.mjs$/);
  });

  it('falls back to default when no version is supplied', () => {
    const r = resolvePatchFile(FIXTURE_CORE, 'example_versioned');
    assert.equal(r.variant, 'default');
  });
});

describe('version-resolver: missing default + no matching range throws', () => {
  it('throws a clear error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-pv-'));
    try {
      const dir = path.join(tmp, 'only_versioned');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '>=2.1.150.mjs'),
        'export default { description: "x", testedAgainst: [">=2.1.150"], verify: { present: "x", weak: true }, apply: c => c };\n');
      assert.throws(
        () => resolvePatchFile(tmp, 'only_versioned', '2.1.100'),
        /no default.*no version variant matches/s,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when an unparseable variant stem appears in a version dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-pv-'));
    try {
      const dir = path.join(tmp, 'bad');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'not-a-version.mjs'),
        'export default { description: "x", verify: { present: "x", weak: true }, apply: c => c };\n');
      assert.throws(
        () => scanVariantDir(dir),
        /unparseable version stem/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('manifest: testedAgainst validation', () => {
  it('rejects per-version variant without testedAgainst', () => {
    const mod = {
      description: 'x',
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, '2.1.148.mjs', { variant: '2.1.148' });
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('testedAgainst')), `errors: ${errors}`);
  });

  it('rejects testedAgainst mismatching the filename variant', () => {
    const mod = {
      description: 'x',
      testedAgainst: ['2.1.149'],
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, '2.1.148.mjs', { variant: '2.1.148' });
    assert.equal(ok, false);
    assert.ok(
      errors.some(e => e.includes('does not match filename variant')),
      `errors: ${errors}`,
    );
  });

  it('accepts matching testedAgainst on a variant', () => {
    const mod = {
      description: 'x',
      testedAgainst: ['2.1.148'],
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors, normalized } = validateManifest(mod, '2.1.148.mjs', { variant: '2.1.148' });
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.deepEqual(normalized.testedAgainst, ['2.1.148']);
    assert.equal(normalized.resolvedVariant, '2.1.148');
  });

  it('accepts range testedAgainst on a range variant', () => {
    const mod = {
      description: 'x',
      testedAgainst: ['>=2.1.150'],
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, '>=2.1.150.mjs', { variant: '>=2.1.150' });
    assert.equal(ok, true, `unexpected errors: ${errors}`);
  });

  it('treats default-variant testedAgainst as optional', () => {
    const mod = {
      description: 'x',
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'foo.mjs', { variant: 'default' });
    assert.equal(ok, true, `unexpected errors: ${errors}`);
  });

  it('rejects malformed testedAgainst entries', () => {
    const mod = {
      description: 'x',
      testedAgainst: ['not-a-version'],
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'foo.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('testedAgainst')), `errors: ${errors}`);
  });
});

describe('loadPatches: picks correct variant from fixture', () => {
  it('loads the 2.1.148 variant when version=2.1.148', async () => {
    const patches = await loadPatches({
      patchesDir: FIXTURE_CORE,
      extensionsDir: FIXTURE_EXT,
      version: '2.1.148',
    });
    assert.ok(patches.example_versioned, 'patch not loaded');
    assert.equal(patches.example_versioned.__resolvedVariant, '2.1.148');
    assert.equal(patches.example_versioned.apply(''), ' EV-2.1.148');
  });

  it('loads the >=2.1.150 variant when version=2.1.151', async () => {
    const patches = await loadPatches({
      patchesDir: FIXTURE_CORE,
      extensionsDir: FIXTURE_EXT,
      version: '2.1.151',
    });
    assert.equal(patches.example_versioned.__resolvedVariant, '>=2.1.150');
    assert.equal(patches.example_versioned.apply(''), ' EV->=2.1.150');
  });

  it('falls back to default for an unmatched version', async () => {
    const patches = await loadPatches({
      patchesDir: FIXTURE_CORE,
      extensionsDir: FIXTURE_EXT,
      version: '2.0.0',
    });
    assert.equal(patches.example_versioned.__resolvedVariant, 'default');
    assert.equal(patches.example_versioned.apply(''), ' EV-DEFAULT');
  });
});

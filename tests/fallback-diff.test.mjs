import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPatch, applyPatch } from 'diff';
import { applyNamedPatches } from '../runner/runner.mjs';
import { validateManifest } from '../runner/manifest.mjs';
import { parsePatchCliArgs, runFallbackCapture } from '../runner/cli.mjs';

function mkLogger() {
  const entries = { log: [], warn: [], error: [] };
  return {
    entries,
    log:   (...a) => { entries.log.push(a.join(' ')); },
    warn:  (...a) => { entries.warn.push(a.join(' ')); },
    error: (...a) => { entries.error.push(a.join(' ')); },
  };
}

// Build a unified diff that transforms `before` -> `after`.
function diffOf(before, after, label = 'fixture.js') {
  return createPatch(label, before, after, 'before', 'after');
}

describe('fallbackDiff — runtime fallback', () => {
  it('applies stored diff when apply() returns no change', async () => {
    const original = 'line1\nline2\nline3\n';
    const target   = 'line1\nline2-CHANGED\nline3\n';
    const fallback = diffOf(original, target);

    const patches = {
      drifted: {
        description: 't',
        apply: (c) => c, // anchor missed — no change
        verify: { present: 'line2-CHANGED', weak: true },
        fallbackDiff: { patch: fallback, capturedAgainst: '2.1.148' },
      },
    };
    const logger = mkLogger();
    const out = await applyNamedPatches(original, patches, ['drifted'], logger);
    assert.equal(out, target);
    assert.ok(
      logger.entries.log.some(l => l.includes('[fallback] drifted') && l.includes('stored-diff applied')),
      `expected fallback success log, got: ${JSON.stringify(logger.entries.log)}`,
    );
  });

  it('logs hard drift when apply() returns no change and fallback also fails', async () => {
    const original = 'line1\nline2\nline3\n';
    const bogus    = diffOf('totally-different-A\n', 'totally-different-B\n');

    const patches = {
      drifted: {
        description: 't',
        apply: (c) => c,
        verify: { present: 'will-not-be-there', weak: true },
        fallbackDiff: { patch: bogus, capturedAgainst: '2.1.148', fuzz: 0 },
      },
    };
    const logger = mkLogger();
    const out = await applyNamedPatches(original, patches, ['drifted'], logger);
    assert.equal(out, original);
    assert.ok(
      logger.entries.warn.some(w => w.includes('produced no changes')),
      `expected hard-drift warning, got: ${JSON.stringify(logger.entries.warn)}`,
    );
  });

  it('does NOT consult fallback when apply() actually changed the code', async () => {
    const original = 'line1\nline2\nline3\n';
    // Intentionally invalid diff — would throw or return false if applied.
    const bogus = 'not a real diff\n';
    let fallbackTouched = false;

    const patches = {
      ok: {
        description: 't',
        apply: (c) => c.replace('line2', 'line2-OK'),
        verify: { present: 'line2-OK', weak: true },
        get fallbackDiff() {
          fallbackTouched = true;
          return { patch: bogus, capturedAgainst: '2.1.148' };
        },
      },
    };
    const logger = mkLogger();
    const out = await applyNamedPatches(original, patches, ['ok'], logger);
    assert.ok(out.includes('line2-OK'));
    // The fallback property may be read once by manifest normalization, but
    // the runtime fallback branch must not produce a [fallback] log line.
    assert.ok(
      !logger.entries.log.some(l => l.includes('[fallback]')),
      `fallback should not be consulted when apply() succeeded`,
    );
    // Suppress unused-var lint.
    void fallbackTouched;
  });

  it('disableFallback: true skips fallback even when present', async () => {
    const original = 'line1\nline2\nline3\n';
    const target   = 'line1\nline2-CHANGED\nline3\n';
    const fallback = diffOf(original, target);

    const patches = {
      drifted: {
        description: 't',
        apply: (c) => c,
        verify: { present: 'line2-CHANGED', weak: true },
        fallbackDiff: { patch: fallback, capturedAgainst: '2.1.148' },
      },
    };
    const logger = mkLogger();
    const out = await applyNamedPatches(
      original, patches, ['drifted'], logger, { disableFallback: true },
    );
    assert.equal(out, original);
    assert.ok(
      !logger.entries.log.some(l => l.includes('[fallback]')),
      `disableFallback must suppress all fallback activity`,
    );
    assert.ok(
      logger.entries.warn.some(w => w.includes('produced no changes')),
    );
  });
});

describe('fallbackDiff — manifest validation', () => {
  const baseMod = {
    description: 't',
    apply: (c) => c,
    verify: { present: 'x', weak: true },
  };

  it('rejects fallbackDiff missing patch', () => {
    const { ok, errors } = validateManifest(
      { ...baseMod, fallbackDiff: { capturedAgainst: '2.1.148' } },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /fallbackDiff\.patch/.test(e)),
      `expected patch-required error, got: ${errors.join(' | ')}`);
  });

  it('rejects fallbackDiff missing capturedAgainst', () => {
    const { ok, errors } = validateManifest(
      { ...baseMod, fallbackDiff: { patch: '--- a\n+++ b\n' } },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /capturedAgainst/.test(e)),
      `expected capturedAgainst-required error, got: ${errors.join(' | ')}`);
  });

  it('rejects fallbackDiff with negative fuzz', () => {
    const { ok, errors } = validateManifest(
      { ...baseMod, fallbackDiff: { patch: 'x', capturedAgainst: '2.1.148', fuzz: -1 } },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /fuzz/.test(e)));
  });

  it('accepts valid fallbackDiff and normalizes default fuzz=3', () => {
    const { ok, errors, normalized } = validateManifest(
      { ...baseMod, fallbackDiff: { patch: '--- a\n+++ b\n', capturedAgainst: '2.1.148' } },
      'p.mjs',
    );
    assert.equal(ok, true, errors.join(' | '));
    assert.equal(normalized.fallbackDiff.fuzz, 3);
    assert.equal(normalized.fallbackDiff.capturedAgainst, '2.1.148');
  });
});

describe('fallback-capture CLI', () => {
  it('parses fallback-capture args', () => {
    const parsed = parsePatchCliArgs(['fallback-capture', '/tmp/p.js', '--against', '/tmp/u.js', '--patch', 'foo']);
    assert.equal(parsed.fallbackCapture, true);
    assert.ok(parsed.patchedPath.endsWith('/p.js'));
    assert.ok(parsed.againstPath.endsWith('/u.js'));
    assert.equal(parsed.patchName, 'foo');
  });

  it('errors when --against is missing', () => {
    const parsed = parsePatchCliArgs(['fallback-capture', '/tmp/p.js']);
    assert.ok(parsed.error && /against/.test(parsed.error));
  });

  it('prints a valid unified diff between two synthetic strings', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-fc-'));
    const unpatchedPath = path.join(tmp, 'u.js');
    const patchedPath   = path.join(tmp, 'p.js');
    const unpatched = 'foo\nbar\nbaz\n';
    const patched   = 'foo\nBAR-NEW\nbaz\n';
    fs.writeFileSync(unpatchedPath, unpatched);
    fs.writeFileSync(patchedPath, patched);

    // Capture stdout.
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(typeof s === 'string' ? s : s.toString()); return true; };
    try {
      const rc = await runFallbackCapture({
        patchedPath, againstPath: unpatchedPath, patchName: 'demo',
      }, { log() {}, warn() {}, error() {} });
      assert.equal(rc, 0);
    } finally {
      process.stdout.write = origWrite;
    }
    const out = chunks.join('');
    assert.ok(out.includes('---'), 'expected unified diff header');
    assert.ok(out.includes('+++'), 'expected unified diff header');
    assert.ok(out.includes('BAR-NEW'), 'expected new content in diff');

    // The captured diff should re-apply onto the unpatched fixture cleanly.
    const reapplied = applyPatch(unpatched, out);
    assert.equal(reapplied, patched);
  });
});

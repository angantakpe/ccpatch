import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { buildRefmap, defaultRefmapPath, refmapsEqual } from '../tools/build-refmap.mjs';
import { loadRefmap, resolveSymbol } from '../runner/refmap.mjs';
import { resolveAnchor, anchors } from '../runner/anchors.mjs';
import { runPatchCli } from '../runner/cli.mjs';

const silent = { log() {}, warn() {}, error() {} };

/**
 * Synthetic micro-bundle that contains parseable functions wrapping each
 * stable feature-flag literal from runner/anchors.mjs. The function names
 * mimic minified single/double-letter identifiers so we can assert the
 * refmap captures them.
 */
const FIXTURE =
  'var prefix=1;' +
  'function Wj7(){return ff("tengu_kairos_cron_durable",!0,helper)}' +
  ';function yK2(){return ff("tengu_kairos_loop_dynamic",!1)}' +
  ';function Lp3(){return ff("tengu_kairos_loop_prompt",!1)}' +
  ';function Lq8(){let H=process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE;' +
  'if(isOn(H))return!0;if(isOff(H))return!1;' +
  'return ff("tengu_plan_mode_interview_phase",!1)}' +
  ';var suffix=2;';

const EXPECTED = {
  isDurableCronEnabled:        { fn: 'Wj7' },
  isLoopDynamicEnabled:        { fn: 'yK2' },
  isLoopPromptEnabled:         { fn: 'Lp3' },
  isPlanModeInterviewEnabled:  { fn: 'Lq8' },
};

const FIXTURE_SHA = createHash('sha256').update(FIXTURE, 'utf8').digest('hex');

function mkTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-refmap-'));
  fs.mkdirSync(path.join(root, 'refmaps'), { recursive: true });
  return root;
}

describe('buildRefmap (programmatic)', () => {
  it('resolves every literal-bearing anchor in the fixture bundle', () => {
    const refmap = buildRefmap(FIXTURE, { ccVersion: '9.9.9' });
    assert.equal(refmap.ccVersion, '9.9.9');
    assert.equal(refmap.bundleSha256, FIXTURE_SHA);
    assert.equal(refmap.misses.length, 0, `unexpected misses: ${refmap.misses.join(',')}`);
    for (const [id, want] of Object.entries(EXPECTED)) {
      const got = refmap.anchors[id];
      assert.ok(got, `missing anchor: ${id}`);
      assert.equal(got.fn, want.fn, `${id}: expected fn=${want.fn}, got fn=${got.fn}`);
      assert.equal(typeof got.offset, 'number');
      // Offset must point at the 'function' keyword of the named function.
      assert.equal(FIXTURE.slice(got.offset, got.offset + 8), 'function');
    }
  });

  it('records misses when literals are not present', () => {
    const refmap = buildRefmap('var x=1;', { ccVersion: 'test' });
    const eligible = Object.entries(anchors).filter(([, e]) => e.literal).map(([k]) => k);
    for (const id of eligible) {
      assert.ok(refmap.misses.includes(id), `expected miss: ${id}`);
    }
    assert.equal(Object.keys(refmap.anchors).length, 0);
  });
});

describe('loadRefmap', () => {
  it('returns null when the refmap file is absent', () => {
    const root = mkTmpRoot();
    assert.equal(loadRefmap('1.2.3', root), null);
    assert.equal(loadRefmap(null, root), null);
    assert.equal(loadRefmap(undefined, root), null);
  });

  it('parses a refmap file and exposes resolveSymbol lookups', () => {
    const root = mkTmpRoot();
    const refmap = buildRefmap(FIXTURE, { ccVersion: '9.9.9' });
    fs.writeFileSync(path.join(root, 'refmaps', '9.9.9.json'), JSON.stringify(refmap));
    const loaded = loadRefmap('9.9.9', root);
    assert.ok(loaded);
    assert.equal(loaded.bundleSha256, FIXTURE_SHA);
    assert.deepEqual(
      resolveSymbol(loaded, 'isDurableCronEnabled'),
      { fn: 'Wj7', offset: refmap.anchors.isDurableCronEnabled.offset },
    );
    assert.equal(resolveSymbol(loaded, 'unknownAnchor'), null);
    assert.equal(resolveSymbol(null, 'isDurableCronEnabled'), null);
  });
});

describe('resolveAnchor precedence', () => {
  it('prefers an explicit version-specific regex entry over the refmap', async (t) => {
    const id = 'isDurableCronEnabled';
    const SENTINEL = /__VERSION_PINNED_SENTINEL__/;
    const entry = anchors[id];
    entry['0.0.0-refmap-pin'] = SENTINEL;

    // Write a refmap that would otherwise be used (under the real
    // PROJECT_ROOT/refmaps). It must be ignored in favor of the registry entry.
    const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
    const refmapDir = path.join(projectRoot, 'refmaps');
    fs.mkdirSync(refmapDir, { recursive: true });
    const refmapPath = path.join(refmapDir, '0.0.0-refmap-pin.json');
    fs.writeFileSync(refmapPath, JSON.stringify(buildRefmap(FIXTURE, { ccVersion: '0.0.0-refmap-pin' })));
    t.after(() => {
      delete entry['0.0.0-refmap-pin'];
      try { fs.unlinkSync(refmapPath); } catch {}
    });

    const result = resolveAnchor(id, '0.0.0-refmap-pin');
    assert.ok(result);
    assert.equal(result.pattern, SENTINEL);
    assert.equal(result.source, 'registry-version');
  });

  it('falls back to refmap when only the default regex entry exists', async (t) => {
    const id = 'isDurableCronEnabled';
    const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
    const refmapDir = path.join(projectRoot, 'refmaps');
    fs.mkdirSync(refmapDir, { recursive: true });
    const versionStem = '0.0.0-refmap-fallback';
    const refmapPath = path.join(refmapDir, `${versionStem}.json`);
    const refmap = buildRefmap(FIXTURE, { ccVersion: versionStem });
    fs.writeFileSync(refmapPath, JSON.stringify(refmap));
    t.after(() => { try { fs.unlinkSync(refmapPath); } catch {} });

    // Ensure no version-specific registry entry exists for this stem.
    assert.equal(Object.prototype.hasOwnProperty.call(anchors[id], versionStem), false);

    const result = resolveAnchor(id, versionStem);
    assert.ok(result, 'expected resolveAnchor to return a result');
    assert.equal(result.source, 'refmap');
    assert.ok(result.pattern instanceof RegExp);
    assert.ok(result.pattern.test(FIXTURE), `pattern ${result.pattern} did not match fixture`);
  });

  it('falls through to default regex when no refmap is present', () => {
    const id = 'isDurableCronEnabled';
    const result = resolveAnchor(id, '0.0.0-no-refmap-here');
    assert.ok(result);
    assert.equal(result.source, 'registry-default');
    assert.equal(result.pattern, anchors[id].default);
  });
});

describe('ccpatch refmap CLI', () => {
  it('writes a refmap and --check round-trips equality', async () => {
    const root = mkTmpRoot();
    const bundlePath = path.join(root, 'bundle.js');
    fs.writeFileSync(bundlePath, FIXTURE);
    const outPath = path.join(root, 'refmaps', 'cli-test.json');

    const rc = await runPatchCli(
      ['refmap', bundlePath, '--out', outPath, '--cc-version', 'cli-test'],
      silent,
    );
    assert.equal(rc, 0);
    assert.ok(fs.existsSync(outPath));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(parsed.ccVersion, 'cli-test');
    assert.equal(parsed.bundleSha256, FIXTURE_SHA);

    const checkRc = await runPatchCli(
      ['refmap', bundlePath, '--out', outPath, '--cc-version', 'cli-test', '--check'],
      silent,
    );
    assert.equal(checkRc, 0);
  });

  it('--check exits non-zero on drift', async () => {
    const root = mkTmpRoot();
    const bundlePath = path.join(root, 'bundle.js');
    fs.writeFileSync(bundlePath, FIXTURE);
    const outPath = path.join(root, 'refmaps', 'drift-test.json');

    const wrong = buildRefmap(FIXTURE, { ccVersion: 'drift-test' });
    wrong.anchors.isDurableCronEnabled.fn = 'XX_DRIFTED_XX';
    fs.writeFileSync(outPath, JSON.stringify(wrong, null, 2));

    const rc = await runPatchCli(
      ['refmap', bundlePath, '--out', outPath, '--cc-version', 'drift-test', '--check'],
      silent,
    );
    assert.equal(rc, 1);
  });
});

describe('refmapsEqual', () => {
  it('ignores generatedAt but respects bundleSha, ccVersion, anchors, misses', () => {
    const a = buildRefmap(FIXTURE, { ccVersion: 'x' });
    const b = buildRefmap(FIXTURE, { ccVersion: 'x' });
    b.generatedAt = 'different-timestamp';
    assert.equal(refmapsEqual(a, b), true);
    b.anchors.isDurableCronEnabled.offset += 1;
    assert.equal(refmapsEqual(a, b), false);
  });
});

describe('defaultRefmapPath', () => {
  it('uses ccVersion when present', () => {
    const p = defaultRefmapPath('2.1.148', 'abcd', '/root');
    assert.equal(p, path.join('/root', 'refmaps', '2.1.148.json'));
  });
  it('falls back to sha-prefix when ccVersion missing', () => {
    const p = defaultRefmapPath(null, 'abcdef0123456789xx', '/root');
    assert.equal(p, path.join('/root', 'refmaps', 'sha-abcdef012345.json'));
  });
});

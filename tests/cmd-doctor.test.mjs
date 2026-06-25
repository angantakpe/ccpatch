// tests/cmd-doctor.test.mjs — end-to-end tests for the `ccpatch doctor` command
// shell (runner/cli/cmd-doctor.mjs). Unlike dissect.test.mjs (which exercises
// the analyzeBundle library primitive), this drives the COMMAND: runDoctor /
// runDoctorCore against a synthetic JS bundle + synthetic patch objects, so the
// classification (OK / UNVERIFIED / MISSING) and the exit-code contract are
// covered without a real Claude Code bundle.
//
// Coverage:
//   - the command-table parse() for `doctor` (flags + missing-arg error)
//   - runDoctorCore classifies OK / UNVERIFIED / DRIFT / EXTINCT correctly and
//     reports the per-status tally
//   - exit code 1 when an anchor is EXTINCT (the absent-literal bucket that
//     CI's version matrix fails on), 0 when all healthy
//   - exit code 1 under --strict when a patch is UNVERIFIED (weak verify)
//   - exit code 1 when the input bundle does not exist

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDoctorCore } from '../runner/cli/cmd-doctor.mjs';
import { buildCommandTable } from '../runner/cli/commands.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureLogger() {
  const lines = [];
  const errs = [];
  return {
    lines,
    errs,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => errs.push(a.join(' ')),
    debug: () => {},
  };
}
function out(l) { return l.lines.join('\n'); }
function err(l) { return l.errs.join('\n'); }

// A synthetic bundle carrying two stable string-literal markers, including the
// real `tengu_kairos_cron_durable` token so a "drifted" patch can fuzzy-match a
// candidate (DRIFT) while a patch keyed on a vanished literal goes EXTINCT.
const BUNDLE =
  'var head=1;\n' +
  'function f(){return "marker_alpha"}\n' +
  'function q(){return Q("tengu_kairos_cron_durable",!1)}\n' +
  'var tail=2;\n';

// Synthetic patches. probeAnchor (which the doctor calls) runs apply(code) and
// then classifies the result against the verify block:
//   - strong OK : apply CHANGES code + verify.present + verify.count → ok, not weak
//   - UNVERIFIED: apply CHANGES code + verify.present ONLY            → ok, weak
//   - DRIFT     : apply no-op + verify.present absent, BUT anchor.literal
//                 fuzzy-matches a candidate in the bundle             → drift
//   - EXTINCT   : apply no-op + verify.present whose literal has ZERO fuzzy
//                 candidates anywhere in the bundle                   → extinct
function patchStrong() {
  return {
    description: 'inserts a unique sentinel, verified strongly',
    verify: { present: '__ccp_doctor_sentinel__', count: { present: 1 } },
    apply: (code) => code.includes('__ccp_doctor_sentinel__')
      ? code
      : code.replace('var head=1;', 'var head=1;/*__ccp_doctor_sentinel__*/'),
  };
}
function patchWeak() {
  return {
    description: 'inserts a sentinel but only has present (weak verify)',
    verify: { present: '__ccp_weak_sentinel__' },
    apply: (code) => code.includes('__ccp_weak_sentinel__')
      ? code
      : code.replace('var tail=2;', 'var tail=2;/*__ccp_weak_sentinel__*/'),
  };
}
function patchDrift() {
  return {
    description: 'anchor literal present but the exact verify form drifted',
    // The literal IS in the bundle (fuzzy candidate found) but the patched
    // shape we verify on never lands → classifyDrift returns drift.
    anchor: { literal: 'tengu_kairos_cron_durable' },
    verify: { present: 'tengu_kairos_cron_durable_PATCHED_FORM' },
    apply: (code) => code, // no change → relies on verify, which fails
  };
}
function patchExtinct() {
  return {
    description: 'expects a marker that is not in this bundle at all',
    // No anchor.literal and the verify token is absent → zero fuzzy candidates
    // → EXTINCT (the loud, heal-cannot-help bucket).
    verify: { present: '__never_in_bundle__' },
    apply: (code) => code,
  };
}

// runDoctorCore reads ccpatch.yml from process.cwd() to decide the patch set.
// With no flags it falls back to "all keys of the patches object", which is
// exactly our synthetic set — so we run from a cwd that has no ccpatch.yml.
let cwdGuard;
let scratchCwd;
before(() => {
  cwdGuard = process.cwd();
  scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-doctor-cwd-'));
  process.chdir(scratchCwd);
});
after(() => {
  process.chdir(cwdGuard);
});

function tmpBundle(code = BUNDLE) {
  const p = path.join(scratchCwd, `bundle-${process.hrtime.bigint()}.js`);
  fs.writeFileSync(p, code, 'utf8');
  return p;
}

// ── command-table parse() ─────────────────────────────────────────────────────

describe('commands table — doctor parse()', () => {
  const { byName } = buildCommandTable({
    parseBuild: () => ({}), runBuild: () => 0, runRevert: () => 0, runDiff: () => 0,
    runReplCommand: () => 0, runVersions: () => 0, runRefmap: () => 0,
    runFallbackCapture: () => 0, runWatch: () => 0, runCoverage: () => 0,
    runDoctor: () => 0, runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
  });

  it('parses input path, --profile and --strict', () => {
    const opts = byName.get('doctor').parse(['some/cli.js', '--profile', 'native', '--strict']);
    assert.equal(opts.doctor, true);
    assert.equal(opts.inputPath, path.resolve('some/cli.js'));
    assert.equal(opts.profile, 'native');
    assert.equal(opts.strict, true);
    assert.equal(opts.suggest, false);
  });

  it('returns a Usage error when no input is given', () => {
    const opts = byName.get('doctor').parse([]);
    assert.ok(opts.error);
    assert.match(opts.error, /Usage: node patch-cli\.mjs doctor/);
  });
});

// ── classification + exit codes ───────────────────────────────────────────────

describe('runDoctorCore — classifies OK / UNVERIFIED / DRIFT / EXTINCT', () => {
  it('reports each status and exits 1 because an EXTINCT anchor is present', async () => {
    const logger = captureLogger();
    const tally = {};
    const rc = await runDoctorCore(
      { inputPath: tmpBundle(), profile: null, strict: false },
      {
        strong: patchStrong(),
        weak: patchWeak(),
        drifted: patchDrift(),
        gone: patchExtinct(),
      },
      logger,
      tally,
    );
    // strong → OK, weak → UNVERIFIED, drifted → DRIFT, gone → EXTINCT
    assert.equal(tally.ok, 1);
    assert.equal(tally.unverified, 1);
    assert.equal(tally.drift, 1);
    assert.equal(tally.extinct, 1);
    assert.equal(tally.missing, 0);
    assert.match(out(logger), /OK\s+strong/);
    assert.match(out(logger), /UNVERIFIED\s+weak/);
    assert.match(out(logger), /DRIFT\s+drifted/);
    assert.match(out(logger), /EXTINCT\s+gone/);
    assert.match(out(logger), /1 ok, 1 drifted, 1 unverified, 0 missing, 1 extinct/);
    // EXTINCT fails the doctor exactly as missing always has.
    assert.equal(rc, 1);
  });

  it('returns 0 when every anchor is healthy (no missing/extinct)', async () => {
    const logger = captureLogger();
    const tally = {};
    const rc = await runDoctorCore(
      { inputPath: tmpBundle(), profile: null, strict: false },
      { strong: patchStrong() },
      logger,
      tally,
    );
    assert.equal(rc, 0);
    assert.equal(tally.ok, 1);
    assert.equal(tally.missing, 0);
    assert.match(out(logger), /1 ok, 0 drifted, 0 unverified, 0 missing/);
  });

  it('a weak (UNVERIFIED-only) patch is exit 0 by default but exit 1 under --strict', async () => {
    const patches = { weak: patchWeak() };

    const logger0 = captureLogger();
    const rc0 = await runDoctorCore(
      { inputPath: tmpBundle(), profile: null, strict: false }, patches, logger0, {});
    assert.equal(rc0, 0, 'weak verify is advisory without --strict');
    assert.match(out(logger0), /\[warning\] 1 patch\(es\) have weak verify/);

    const loggerS = captureLogger();
    const rcS = await runDoctorCore(
      { inputPath: tmpBundle(), profile: null, strict: true }, patches, loggerS, {});
    assert.equal(rcS, 1, 'weak verify is a failure under --strict');
    assert.match(err(loggerS), /\[strict\] UNVERIFIED treated as failure: weak/);
  });
});

describe('runDoctorCore — missing input bundle', () => {
  it('returns 1 and reports the file was not found', async () => {
    const logger = captureLogger();
    const rc = await runDoctorCore(
      { inputPath: path.join(scratchCwd, 'does-not-exist.js'), profile: null, strict: false },
      { strong: patchStrong() },
      logger,
      {},
    );
    assert.equal(rc, 1);
    assert.match(err(logger), /cli\.js not found/);
  });
});

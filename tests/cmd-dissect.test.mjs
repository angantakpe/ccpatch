// tests/cmd-dissect.test.mjs — end-to-end tests for the `ccpatch dissect` command
// shell (runner/cli/cmd-dissect.mjs). The analyzeBundle PRIMITIVE is covered by
// tests/dissect.test.mjs; here we drive the COMMAND: flag parsing, the read-only
// report / --json / --against exit-code contract, and the not-found error paths.
// All paths are local + read-only; no network or real bundle is involved.
//
// Coverage:
//   - command-table parse() for `dissect` (flags + missing-arg error)
//   - default report renders an anchor table and exits 0
//   - --json emits a parseable analysis object
//   - --against returns 3 when anchors drifted, 0 when stable
//   - not-found input / not-found --against both return 1

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDissect } from '../runner/cli/cmd-dissect.mjs';
import { buildCommandTable } from '../runner/cli/commands.mjs';
import { resetBundleIndex } from '../runner/ast-anchor.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureLogger() {
  const lines = [];
  const errs = [];
  return {
    lines, errs,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => errs.push(a.join(' ')),
    debug: () => {},
  };
}
function out(l) { return l.lines.join('\n'); }
function err(l) { return l.errs.join('\n'); }

// Two real registry anchors present (cron_durable, loop_dynamic); the same
// synthetic shape tests/dissect.test.mjs uses, so the resolver behaviour is the
// one the library tests already pin.
const CRON = 'function Zx9(){return q("tengu_kairos_cron_durable",!0,h)}';
const LOOP = 'function Yk2(){return q("tengu_kairos_loop_dynamic",!1)}';
function bundleCode(prefix = '') { return `${prefix}${CRON}${LOOP}var tail=1;`; }

function tmpBundle(code) {
  const p = path.join(os.tmpdir(), `cmd-dissect-${process.hrtime.bigint()}.js`);
  fs.writeFileSync(p, code, 'utf8');
  return p;
}

// ── command-table parse() ─────────────────────────────────────────────────────

describe('commands table — dissect parse()', () => {
  const { byName } = buildCommandTable({
    parseBuild: () => ({}), runBuild: () => 0, runRevert: () => 0, runDiff: () => 0,
    runReplCommand: () => 0, runVersions: () => 0, runRefmap: () => 0,
    runFallbackCapture: () => 0, runWatch: () => 0, runCoverage: () => 0,
    runDoctor: () => 0, runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
  });

  it('parses input, --against, --ownership, --context, --json', () => {
    const opts = byName.get('dissect').parse([
      'cli.js', '--against', 'old.js', '--ownership', '--context', '40', '--json',
    ]);
    assert.equal(opts.dissect, true);
    assert.equal(opts.inputPath, path.resolve('cli.js'));
    assert.equal(opts.againstPath, path.resolve('old.js'));
    assert.equal(opts.ownership, true);
    assert.equal(opts.context, 40);
    assert.equal(opts.json, true);
  });

  it('returns a Usage error when no bundle is given', () => {
    const opts = byName.get('dissect').parse([]);
    assert.ok(opts.error);
    assert.match(opts.error, /Usage: ccpatch dissect/);
  });

  it('returns a Usage error when the first token is a flag', () => {
    const opts = byName.get('dissect').parse(['--json']);
    assert.ok(opts.error);
  });
});

// ── default report ────────────────────────────────────────────────────────────

describe('runDissect — default structural report', () => {
  it('renders the anchor table and resolves the present anchors, exits 0', async () => {
    resetBundleIndex();
    const logger = captureLogger();
    const rc = await runDissect({
      options: { inputPath: tmpBundle(bundleCode()), ccVersion: '1.2.3', context: 0, json: false },
      logger,
    });
    assert.equal(rc, 0);
    const body = out(logger);
    assert.match(body, /Bundle/);
    assert.match(body, /1\.2\.3/);              // ccVersion echoed
    assert.match(body, /isDurableCronEnabled/); // a resolved anchor id
    assert.match(body, /anchors resolved/);     // the summary line
  });

  it('--json emits a parseable analysis object with resolved anchors', async () => {
    resetBundleIndex();
    const logger = captureLogger();
    const rc = await runDissect({
      options: { inputPath: tmpBundle(bundleCode()), ccVersion: '9.9.9', context: 0, json: true },
      logger,
    });
    assert.equal(rc, 0);
    const parsed = JSON.parse(out(logger));
    assert.equal(parsed.ccVersion, '9.9.9');
    assert.equal(parsed.format, 'js');
    const cron = parsed.anchors.find(a => a.id === 'isDurableCronEnabled');
    assert.equal(cron.status, 'resolved');
  });
});

// ── --against diff exit code ──────────────────────────────────────────────────

describe('runDissect — cross-version diff exit code', () => {
  it('returns 3 when an anchor moved (drift) and 0 when stable', async () => {
    resetBundleIndex();
    const oldPath = tmpBundle(bundleCode());
    // Moved: a prefix shifts every offset; cron + loop are still present but at
    // new offsets → summary.moved > 0 → exit 3.
    const movedPath = tmpBundle(bundleCode('var prefix_padding=1234;'));

    const driftLogger = captureLogger();
    const driftRc = await runDissect({
      options: { inputPath: movedPath, againstPath: oldPath, json: false },
      logger: driftLogger,
    });
    assert.equal(driftRc, 3, 'moved anchors must signal drift via exit 3');
    assert.match(out(driftLogger), /MOVED/);

    // Identical bundles → nothing moved → exit 0.
    const stableLogger = captureLogger();
    const stableRc = await runDissect({
      options: { inputPath: tmpBundle(bundleCode()), againstPath: oldPath, json: false },
      logger: stableLogger,
    });
    assert.equal(stableRc, 0, 'identical bundles must not signal drift');
  });
});

// ── error paths ───────────────────────────────────────────────────────────────

describe('runDissect — not-found error paths', () => {
  it('returns 1 when the input bundle does not exist', async () => {
    const logger = captureLogger();
    const rc = await runDissect({
      options: { inputPath: path.join(os.tmpdir(), 'cmd-dissect-missing.js'), json: false },
      logger,
    });
    assert.equal(rc, 1);
    assert.match(err(logger), /bundle not found/);
  });

  it('returns 1 when the --against bundle does not exist', async () => {
    const logger = captureLogger();
    const rc = await runDissect({
      options: {
        inputPath: tmpBundle(bundleCode()),
        againstPath: path.join(os.tmpdir(), 'cmd-dissect-against-missing.js'),
        json: false,
      },
      logger,
    });
    assert.equal(rc, 1);
    assert.match(err(logger), /--against bundle not found/);
  });
});

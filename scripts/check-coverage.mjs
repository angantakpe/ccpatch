#!/usr/bin/env node
// Coverage ratchet gate.
//
// Node's native coverage-threshold flags (--test-coverage-lines= etc.) only
// exist on Node >= 22, but CI pins Node 20 (see .github/workflows/ci.yml). So
// instead of the flags we run `--experimental-test-coverage` (supported on 20)
// and parse the "all files" summary row it prints, failing the build when any
// metric drops below a committed floor.
//
// The floors are a RATCHET, not an aspiration: they sit a few points below the
// coverage measured at the time this gate was added, so the gate passes today
// and only fires on real erosion. When coverage climbs, raise the floors — never
// let them drift below the current measured numbers.
//
// Usage:
//   node scripts/check-coverage.mjs            # run tests + check
//   node scripts/check-coverage.mjs --report cov.txt  # check a saved report
//
// Override floors via env (mainly for local experimentation):
//   COVERAGE_MIN_LINES, COVERAGE_MIN_BRANCHES, COVERAGE_MIN_FUNCS

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Measured 2026-06-25 against the full suite: line 70.46 / branch 64.73 /
// funcs 25.84. Floors set ~2-3 points below each (funcs is low by design —
// the patch corpus has many tiny declarative apply()/verify() helpers).
const FLOORS = {
  lines: Number(process.env.COVERAGE_MIN_LINES ?? 68),
  branches: Number(process.env.COVERAGE_MIN_BRANCHES ?? 62),
  funcs: Number(process.env.COVERAGE_MIN_FUNCS ?? 23),
};

function getReport() {
  const reportIdx = process.argv.indexOf('--report');
  if (reportIdx !== -1) {
    const path = process.argv[reportIdx + 1];
    if (!path) {
      console.error('check-coverage: --report requires a file path');
      process.exit(2);
    }
    return readFileSync(path, 'utf8');
  }

  // Mirror the `test:coverage` script's file globbing. We let the shell expand
  // the globs so this stays in lockstep with package.json without re-listing
  // every path here.
  const cmd =
    'node --test --experimental-test-coverage ' +
    'tests/*.test.mjs packages/adk/tests/*.test.mjs';
  const res = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error('check-coverage: failed to run tests:', res.error.message);
    process.exit(2);
  }
  // This gate owns ONE thing: the coverage floor. Test correctness is already
  // gated by the separate `test:all` CI step, so we deliberately do NOT re-fail
  // on a non-zero test exit here — that would make the coverage gate hostage to
  // the suite's known pty/timing-flaky tests (tests/repl.test.mjs, boot-tty)
  // under concurrent CI load. Node prints the `--experimental-test-coverage`
  // report even when individual tests fail, so as long as that report is present
  // (checked by the parser below) the measured coverage is valid. If the report
  // is genuinely absent, the parser fails hard.
  if (res.status !== 0) {
    console.warn(
      `check-coverage: test runner exited ${res.status} (e.g. a flaky test); ` +
        'coverage report still produced — `test:all` owns correctness. Proceeding to floor check.',
    );
  }
  return (res.stdout ?? '') + (res.stderr ?? '');
}

// Parse the totals row, e.g.:
//   ℹ all files                                 |  70.46 |    64.73 |   25.84 |
function parseTotals(report) {
  const lines = report.split('\n');
  const row = lines.find((l) => /all files\s*\|/.test(l));
  if (!row) return null;
  const cells = row
    .split('|')
    .map((c) => c.trim());
  // cells[0] = "… all files", then line %, branch %, funcs %, (uncovered)
  const lineP = Number.parseFloat(cells[1]);
  const branchP = Number.parseFloat(cells[2]);
  const funcsP = Number.parseFloat(cells[3]);
  if ([lineP, branchP, funcsP].some((n) => Number.isNaN(n))) return null;
  return { lines: lineP, branches: branchP, funcs: funcsP };
}

const report = getReport();
const totals = parseTotals(report);

if (!totals) {
  console.error(
    'check-coverage: could not find/parse the "all files" coverage summary row.\n' +
      'Did the coverage report format change, or did the run produce no coverage?',
  );
  process.exit(2);
}

const checks = [
  ['lines', totals.lines, FLOORS.lines],
  ['branches', totals.branches, FLOORS.branches],
  ['funcs', totals.funcs, FLOORS.funcs],
];

let failed = false;
console.log('Coverage gate (ratchet floors):');
for (const [name, actual, floor] of checks) {
  const ok = actual >= floor;
  if (!ok) failed = true;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} ${actual.toFixed(2)}%  (floor ${floor}%)`,
  );
}

if (failed) {
  console.error(
    '\ncheck-coverage: coverage dropped below the ratchet floor. Either add tests ' +
      'to recover, or — if the drop is intentional and justified — lower the floor ' +
      'in scripts/check-coverage.mjs and say why.',
  );
  process.exit(1);
}

console.log('\ncheck-coverage: all coverage floors met.');

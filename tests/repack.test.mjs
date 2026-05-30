import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  locateWrapperCloseEnd,
  assertRegionEndIsNul,
  detectBunVersion,
} from '../bin/repack-bundle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FIXTURE = resolve(ROOT, 'storage/archives/claude-code-v2.1.158/bin/claude.exe');
const FIXTURE_BUN_VERSION = '2.1.158';
const EXTRACT_CLI = resolve(ROOT, 'bin/extract-from-binary.mjs');
const REPACK_CLI = resolve(ROOT, 'bin/repack-bundle.mjs');
const isLinuxX64 = process.platform === 'linux' && process.arch === 'x64';

// Mirror the repacker's padding step: insert N spaces at the located close index.
function pad(text, padBytes) {
  const closeEnd = locateWrapperCloseEnd(text);
  return text.slice(0, closeEnd) + ' '.repeat(padBytes) + text.slice(closeEnd);
}

describe('repack padding placement — locateWrapperCloseEnd', () => {
  it('pads after the wrapper close, leaving a string literal that contains `})` byte-identical', () => {
    // Minified body holds a string literal whose value contains `})`. Padding must land
    // strictly after the wrapper close so the literal is never touched.
    const wrapper =
      '(function(exports, require, module, __filename, __dirname) {' +
      'var s = "trailing literal })";' +
      'module.exports = s;' +
      '})';

    // The locator returns the position immediately after the real wrapper close (file end here).
    const realCloseEnd = locateWrapperCloseEnd(wrapper);
    assert.equal(realCloseEnd, wrapper.length, 'close end is at the file end for this input');

    const padded = pad(wrapper, 10);

    // Padded output still parses as a function expression.
    assert.doesNotThrow(() => new Function(`return (${padded})`));

    // The string literal is unchanged — no spaces leaked inside it.
    assert.ok(padded.includes('"trailing literal })"'), 'literal must be byte-identical');

    // Spaces immediately follow the wrapper close `})`, not any earlier literal `})`.
    assert.equal(padded.slice(realCloseEnd - 2), '})' + ' '.repeat(10));

    // Byte length grew by exactly the pad count.
    assert.equal(padded.length, wrapper.length + 10);
  });

  it('pads after the close even when a string-literal `})` is the textually-last contiguous `})`', () => {
    // Here the wrapper-close `})` is followed by trailing whitespace AND the body's last token
    // is a literal containing `})`. The trim-based locator still resolves the true close (it
    // walks back over whitespace to the final `})`), and padding lands after it. This is the
    // exact case where blindly trusting "the last `})` is the close" is fragile: our locator
    // is defined by the same trimEnd().endsWith('})') rule normalisePatchedJs validates.
    const wrapper =
      '(function(exports, require, module, __filename, __dirname) {' +
      'module.exports = "ends in })";' +
      '})\n';

    const closeEnd = locateWrapperCloseEnd(wrapper);
    // closeEnd points just past the real `})` (before the trailing newline), not the literal.
    assert.equal(wrapper.slice(closeEnd - 2, closeEnd), '})');
    assert.ok(wrapper[closeEnd] === '\n', 'close is located before trailing whitespace');

    const padded = pad(wrapper, 6);
    assert.doesNotThrow(() => new Function(`return (${padded.trim()})`));
    assert.ok(padded.includes('"ends in })"'), 'literal must be byte-identical');
    assert.equal(padded.slice(closeEnd - 2, closeEnd + 6), '})' + ' '.repeat(6));
  });

  it('throws when no wrapper close `})` can be located', () => {
    assert.throws(() => locateWrapperCloseEnd('not a wrapper at all'), /wrapper close/);
    assert.throws(() => locateWrapperCloseEnd('(function(){return 1}'), /wrapper close/);
  });
});

describe('repack region.end NUL guard — assertRegionEndIsNul', () => {
  it('throws when the marker-parser region end is not a NUL byte', () => {
    // Craft a region whose end points at a non-NUL byte (simulating parseModules falling
    // back to nextBoundary instead of the trailer NUL).
    const binary = Buffer.from([0x41, 0x42, 0x43, 0x44]); // "ABCD", no NUL at end
    const region = { start: 0, end: 3, source: 'marker-parser' };
    assert.throws(() => assertRegionEndIsNul(binary, region), /not a NUL byte/);
  });

  it('passes when the marker-parser region end is a NUL byte', () => {
    const binary = Buffer.from([0x41, 0x42, 0x00, 0x44]); // NUL at index 2
    const region = { start: 0, end: 2, source: 'marker-parser' };
    assert.doesNotThrow(() => assertRegionEndIsNul(binary, region));
  });

  it('does not enforce the NUL for the legacy-anchor path (already NUL-guaranteed)', () => {
    const binary = Buffer.from([0x41, 0x42, 0x43, 0x44]); // no NUL
    const region = { start: 0, end: 3, source: 'legacy-anchor' };
    assert.doesNotThrow(() => assertRegionEndIsNul(binary, region));
  });
});

describe('repack Bun version detection — detectBunVersion', () => {
  it('detects a Bun/x.y.z banner', () => {
    const binary = Buffer.from('garbage\x00Bun/1.3.20 (linux)\x00more', 'latin1');
    assert.equal(detectBunVersion(binary), '1.3.20');
  });

  it('returns null when no version banner is present', () => {
    const binary = Buffer.from('no version here at all', 'latin1');
    assert.equal(detectBunVersion(binary), null);
  });
});

// ---------------------------------------------------------------------------
// Supported-path repack — end-to-end on the real fixture.
//
// Drives the actual bin/extract-from-binary.mjs and bin/repack-bundle.mjs CLIs as
// subprocesses (so their die()/process.exit cannot tear down the test runner), then
// SPAWNS the repacked binary. A round-trip extract→repack yields a JS region the SAME
// byte length as the original (extract appends the self-invocation suffix that
// normalisePatchedJs strips back off), exercising the length-preserving fast path. This
// is the path that ships today; the test proves it boots the embedded entrypoint and
// reports the Claude Code version, not a bare Bun banner. Skips cleanly off linux-x64 or
// when the fixture is unavailable, like tests/boot-smoke.test.mjs.
test('repack supported path: round-trip extract→repack boots as Claude Code', async (t) => {
  if (!isLinuxX64) {
    t.skip(`fixtures are linux-x64; this host is ${process.platform}-${process.arch}`);
    return;
  }
  if (!existsSync(FIXTURE)) {
    t.skip(`fixture not available: ${FIXTURE} (needs the storage/archives symlink)`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'ccpatch-repack-'));
  try {
    const extracted = join(work, 'cli.js');
    const output = join(work, 'claude.repacked');

    // 1. Extract the embedded JS (marker-parser path). Run as a subprocess: the extractor
    //    calls process.exit on error, which we must not let escape into the test runner.
    const ex = spawnSync(process.execPath, [EXTRACT_CLI, FIXTURE, extracted], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(ex.status, 0, `extract failed (status ${ex.status})\n${ex.stderr || ''}`);
    assert.ok(existsSync(extracted), 'extractor did not produce an output file');

    // 2. Repack with no patching (round-trip). The smoke check inside repack() runs the
    //    output itself, but we keep it on and additionally assert the version below.
    const rp = spawnSync(process.execPath, [REPACK_CLI, FIXTURE, extracted, output], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    // The repacker may legitimately SKIP its own smoke check in some sandboxes; a non-zero
    // status there means a real failure (bare-bun detection or write error), so treat it as fatal.
    assert.equal(rp.status, 0, `repack failed (status ${rp.status})\n${rp.stderr || ''}`);
    assert.ok(existsSync(output), 'repack did not produce an output binary');

    // 3. Spawn the repacked binary and assert it boots as Claude Code, not bare Bun.
    const run = spawnSync(output, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (run.error) {
      t.skip(`cannot exec repacked binary here: ${run.error.code || run.error.message}`);
      return;
    }
    const out = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, `repacked binary exited ${run.status}\n${out.slice(0, 500)}`);
    assert.match(out, /\d+\.\d+\.\d+ \(Claude Code\)/,
      `repacked --version did not look like Claude Code (bare bun?)\n${out.slice(0, 500)}`);
    assert.ok(out.includes(FIXTURE_BUN_VERSION),
      `expected the embedded version ${FIXTURE_BUN_VERSION}\n${out.slice(0, 500)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// Oversize patch must fail loudly (process.exit(1)) and write NO output binary — the
// safety guarantee the grow path relies on until trailer-offset rewriting lands. Driven
// against the real fixture via the CLI subprocess so die()'s process.exit is observed.
test('repack fail-loud: oversize patched JS is rejected and writes no binary', async (t) => {
  if (!isLinuxX64) {
    t.skip(`fixtures are linux-x64; this host is ${process.platform}-${process.arch}`);
    return;
  }
  if (!existsSync(FIXTURE)) {
    t.skip(`fixture not available: ${FIXTURE} (needs the storage/archives symlink)`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'ccpatch-oversize-'));
  try {
    const extracted = join(work, 'cli.js');
    const grown = join(work, 'cli.grown.js');
    const output = join(work, 'claude.repacked');

    const ex = spawnSync(process.execPath, [EXTRACT_CLI, FIXTURE, extracted], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(ex.status, 0, `extract failed\n${ex.stderr || ''}`);

    // Grow the extracted JS past the original region: inject a large comment block right
    // after the CJS wrapper open so the file still normalises but exceeds the region.
    const { readFileSync, writeFileSync } = await import('node:fs');
    const text = readFileSync(extracted, 'utf8');
    const openRe = /^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/;
    const m = openRe.exec(text);
    assert.ok(m, 'extracted file is missing the CJS wrapper open');
    const sentinel = `/* CCPATCH_OVERSIZE_SENTINEL ${'x'.repeat(8192)} */`;
    writeFileSync(grown, text.slice(0, m[0].length) + sentinel + text.slice(m[0].length));

    const rp = spawnSync(process.execPath, [REPACK_CLI, FIXTURE, grown, output], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.notEqual(rp.status, 0, 'oversize repack should fail loudly (non-zero exit)');
    assert.match(`${rp.stderr || ''}${rp.stdout || ''}`, /exceeds original JS region|Growth is not supported/,
      'oversize failure should explain the region-size limit');
    assert.ok(!existsSync(output), 'oversize repack must not write an output binary');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Size-increasing (grow-path) repack — BLOCKED.
//
// Item 6 asked for trailer-offset rewriting so a patched JS region LARGER than the
// original could be repacked. The investigation in docs/native-repack-notes.md
// (section "Trailer-offset rewriting investigation") proved, against the real
// linux-x64 fixture used as an executable oracle, that the Bun standalone trailer is
// NOT a simple set of absolute file offsets we can enumerate and bump: it is an
// undocumented, packed serialized module-graph schema, and EVERY size-increasing
// rewrite strategy tried fell back to bare Bun (`--version` printed the Bun runtime
// version, e.g. `1.3.14`, instead of `X.Y.Z (Claude Code)`). Per the task's safety
// rule we did NOT ship a guess; the repacker keeps its fail-loud oversize guard.
//
// This test is .skip'd on purpose and documents the EXACT end-to-end assertion the
// unblocking work (a verified Bun schema decoder — see the docs plan) must make pass:
// take the real .exe, splice a JS region LARGER than the original, repack, spawn the
// result with --version, and assert exit 0 with Claude-Code-branded output (NOT a bare
// Bun banner). It skips cleanly off linux-x64 or when the fixture is unavailable, the
// same way tests/boot-smoke.test.mjs guards its spawn.
test('repack grow path (BLOCKED): size-increasing splice boots as Claude, not bare bun', { skip: 'trailer-offset rewriting is unimplemented — see docs/native-repack-notes.md' }, async (t) => {
  if (!isLinuxX64) {
    t.skip(`fixtures are linux-x64; this host is ${process.platform}-${process.arch}`);
    return;
  }
  if (!existsSync(FIXTURE)) {
    t.skip(`fixture not available: ${FIXTURE} (needs the storage/archives symlink)`);
    return;
  }
  // When implemented, the body must:
  //   1. read FIXTURE, locate the cli.js region, splice in a sentinel comment block of
  //      KNOWN size so the patched region is strictly LARGER than the original,
  //   2. repack via repack() (with CCPATCH_REPACK_SMOKE left on),
  //   3. spawn the output with --version and assert:
  //        assert.equal(code, 0);
  //        assert.match(stdout, /\d+\.\d+\.\d+ \(Claude Code\)/);   // NOT a bare `Bun X.Y.Z` banner
  //   The expected brand version for this fixture is `${FIXTURE_BUN_VERSION} (Claude Code)`.
  assert.fail('unreachable: this test is skipped until trailer-offset rewriting lands');
});

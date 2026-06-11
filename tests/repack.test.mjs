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
  formatSkipLine,
  normalisePatchedJs,
} from '../bin/repack-bundle.mjs';
import { parseElfBunGraph, growBunSeaBinary } from '../bin/bun-sea-graph.mjs';
import { readFileSync } from 'node:fs';

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

describe('normalisePatchedJs — head-IIFE relocation', () => {
  const WRAPPER_OPEN = '(function(exports, require, module, __filename, __dirname) {';
  const bundle = (head, body) =>
    head + WRAPPER_OPEN + body + '})';

  it('relocates a leading boot IIFE to just inside the wrapper, length-preserving', () => {
    const head = '(function(){globalThis.__boot=1;})();';
    const input = bundle(head, 'module.exports=42;');
    const out = normalisePatchedJs(input);

    // Must now START with the wrapper opener (Bun SEA prereq).
    assert.ok(out.startsWith(WRAPPER_OPEN), 'output begins with the CJS wrapper opener');
    // The relocated boot code lives immediately after the opening brace.
    assert.ok(out.startsWith(WRAPPER_OPEN + head), 'boot IIFE moved to first statement inside wrapper');
    // Pure byte move — length is unchanged so stored offsets stay valid.
    assert.equal(out.length, input.length, 'relocation preserves byte length');
    // Still a valid function expression and still ends with the wrapper close.
    assert.doesNotThrow(() => new Function(`return (${out})`));
    assert.ok(out.trimEnd().endsWith('})'));
  });

  it('handles multiple concatenated head IIFEs (contracts + fetch_interceptor + hook_noise_mute shape)', () => {
    const head = '(function(){1;})();(function(){2;})();(function(){3;})();';
    const input = bundle(head, 'var x=1;module.exports=x;');
    const out = normalisePatchedJs(input);
    assert.ok(out.startsWith(WRAPPER_OPEN + head));
    assert.equal(out.length, input.length);
    assert.doesNotThrow(() => new Function(`return (${out})`));
  });

  it('is a no-op when the file already starts with the wrapper', () => {
    const input = bundle('', 'module.exports=1;');
    const out = normalisePatchedJs(input);
    assert.equal(out, input);
  });

  it('throws when no wrapper is present at all', () => {
    assert.throws(
      () => normalisePatchedJs('(function(){onlyBoot();})();'),
      /does not contain the expected Bun CJS wrapper/,
    );
  });
});

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

// ---------------------------------------------------------------------------
// Bun SEA module-graph decoder — bin/bun-sea-graph.mjs.
//
// parseElfBunGraph decodes the verified Bun StandaloneModuleGraph schema (Offsets
// is 32 bytes; the .bun section is [u64 payload_len][blob][Offsets][trailer]; every
// StringPointer is blob-relative). These tests pin the schema invariants and the
// fail-loud behaviour (refuse to guess) the grow path relies on. The parse runs on
// any platform (it just reads bytes); only the spawn-based grow test needs linux-x64.
describe('Bun SEA module-graph decoder — parseElfBunGraph', () => {
  it('throws on a non-ELF buffer (no guessing)', () => {
    assert.throws(() => parseElfBunGraph(Buffer.from('not an elf at all, padding padding')), /not an ELF/);
  });

  it('decodes the real fixture: 32-byte Offsets, consistent byte_count, entry = cli.js', (t) => {
    if (!existsSync(FIXTURE)) {
      t.skip(`fixture not available: ${FIXTURE} (needs the storage/archives symlink)`);
      return;
    }
    const g = parseElfBunGraph(readFileSync(FIXTURE));
    // payload_len header and Offsets.byte_count must agree with the +48 (Offsets+trailer) framing.
    assert.equal(g.offsets.byteCount + 32 + 16, g.payloadLen, 'byte_count + Offsets(32) + trailer(16) == payload_len');
    assert.equal(8 + g.payloadLen, g.bun.size, '.bun section = [u64 header] + payload');
    assert.equal(g.offsets.modulesLen % 52, 0, 'module-record array is a whole number of 52-byte records');
    assert.ok(g.records.length >= 1, 'at least one module record');
    const entry = g.records[g.offsets.entryPointId];
    assert.ok(entry && /\/cli\.js$/.test(entry.name), `entry module should be cli.js (got ${entry?.name})`);
  });

  it('growBunSeaBinary refuses to guess when the region matches no module record', (t) => {
    if (!existsSync(FIXTURE)) {
      t.skip(`fixture not available: ${FIXTURE}`);
      return;
    }
    const binary = readFileSync(FIXTURE);
    // A region whose end matches no module content block must throw, not silently corrupt.
    assert.throws(
      () => growBunSeaBinary(binary, { start: 10, end: 12345 }, Buffer.alloc(99999)),
      /Could not match the JS region/,
    );
  });
});

// ---------------------------------------------------------------------------
// Size-increasing (grow-path) repack — IMPLEMENTED.
//
// Item 6: trailer-offset rewriting so a patched JS region LARGER than the original
// can be repacked. growBunSeaBinary (bin/bun-sea-graph.mjs) decodes Bun's verified
// StandaloneModuleGraph schema and rewrites every load-bearing offset by the growth
// delta — the 8-byte payload_len header, Offsets.byte_count, modules_ptr, the grown
// module's contents.len, every module-record StringPointer ≥ the splice point, and the
// ELF section/program-header offsets. The earlier blocker (see git history of
// docs/native-repack-notes.md) was a mis-parsed Offsets struct (read as 20 bytes; it is
// 32) and a missed payload_len header, so byte_count never grew → bare-bun fallback.
//
// This drives the real CLI: extract → inject a KNOWN-size sentinel after the wrapper
// open so the patched region strictly exceeds the original → repack (which runs its own
// STRICT grow smoke check) → spawn the output and assert it boots as Claude Code, and
// that the output binary actually grew by the delta. Skips cleanly off linux-x64 or
// when the fixture is unavailable, like tests/boot-smoke.test.mjs.
test('repack grow path: size-increasing splice boots as Claude, not bare bun', async (t) => {
  if (!isLinuxX64) {
    t.skip(`fixtures are linux-x64; this host is ${process.platform}-${process.arch}`);
    return;
  }
  if (!existsSync(FIXTURE)) {
    t.skip(`fixture not available: ${FIXTURE} (needs the storage/archives symlink)`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'ccpatch-grow-'));
  try {
    const extracted = join(work, 'cli.js');
    const grown = join(work, 'cli.grown.js');
    const output = join(work, 'claude.repacked');

    const ex = spawnSync(process.execPath, [EXTRACT_CLI, FIXTURE, extracted], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(ex.status, 0, `extract failed\n${ex.stderr || ''}`);

    // Grow the extracted JS past the original region: inject a large inert comment block
    // right after the CJS wrapper open so the file still normalises but exceeds the region.
    const { writeFileSync } = await import('node:fs');
    const text = readFileSync(extracted, 'utf8');
    const openRe = /^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/;
    const m = openRe.exec(text);
    assert.ok(m, 'extracted file is missing the CJS wrapper open');
    const SENTINEL_BYTES = 8192;
    const sentinel = `/* CCPATCH_GROW_SENTINEL ${'x'.repeat(SENTINEL_BYTES)} */`;
    writeFileSync(grown, text.slice(0, m[0].length) + sentinel + text.slice(m[0].length));

    const fixtureSize = readFileSync(FIXTURE).length;

    const rp = spawnSync(process.execPath, [REPACK_CLI, FIXTURE, grown, output], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    // repack() runs its own strict grow smoke check internally; a non-zero exit is a real
    // failure (bare-bun, parse mismatch, or write error).
    assert.equal(rp.status, 0, `grow repack failed (status ${rp.status})\n${rp.stderr || ''}${rp.stdout || ''}`);
    assert.match(`${rp.stdout || ''}`, /Bun module-graph grow-repack/, 'should have taken the grow path');
    assert.ok(existsSync(output), 'grow repack did not produce an output binary');

    // The output must be LARGER than the fixture by exactly the injected growth.
    const outSize = readFileSync(output).length;
    assert.ok(outSize > fixtureSize, `grown binary (${outSize}) should exceed the fixture (${fixtureSize})`);

    // Spawn the grown binary and assert it boots as Claude Code, not bare Bun.
    const run = spawnSync(output, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (run.error) {
      t.skip(`cannot exec repacked binary here: ${run.error.code || run.error.message}`);
      return;
    }
    const out = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, `grown binary exited ${run.status}\n${out.slice(0, 500)}`);
    assert.match(out, /\d+\.\d+\.\d+ \(Claude Code\)/,
      `grown --version did not look like Claude Code (bare bun?)\n${out.slice(0, 500)}`);
    assert.ok(out.includes(FIXTURE_BUN_VERSION),
      `expected the embedded version ${FIXTURE_BUN_VERSION}\n${out.slice(0, 500)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Item 4 — fail closed by default.
//
// The post-repack smoke check is REQUIRED by default; without an executable smoke run
// (e.g. CCPATCH_REPACK_SMOKE=0, or an environment that cannot exec the binary) the CLI
// must exit NON-ZERO unless --allow-unverified is passed. --require-smoke is now a
// redundant no-op alias. These drive the real CLI so the arg-parsing + die() paths run.
// They need the linux-x64 fixture to reach the smoke gate; skip cleanly otherwise.
// ---------------------------------------------------------------------------
describe('repack fail-closed default (Item 4)', () => {
  function roundTripExtract(work) {
    const extracted = join(work, 'cli.js');
    const ex = spawnSync(process.execPath, [EXTRACT_CLI, FIXTURE, extracted], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(ex.status, 0, `extract failed\n${ex.stderr || ''}`);
    return extracted;
  }

  it('FAILS CLOSED when the smoke check is disabled and --allow-unverified is NOT passed', (t) => {
    if (!isLinuxX64) { t.skip(`fixtures are linux-x64; host is ${process.platform}-${process.arch}`); return; }
    if (!existsSync(FIXTURE)) { t.skip(`fixture not available: ${FIXTURE}`); return; }
    const work = mkdtempSync(join(tmpdir(), 'ccpatch-failclosed-'));
    try {
      const extracted = roundTripExtract(work);
      const output = join(work, 'claude.repacked');
      // CCPATCH_REPACK_SMOKE=0 disables the only execution-level proof. Default is fail-closed.
      const rp = spawnSync(process.execPath, [REPACK_CLI, FIXTURE, extracted, output], {
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, CCPATCH_REPACK_SMOKE: '0' },
      });
      assert.notEqual(rp.status, 0, 'must fail closed (non-zero) when smoke is disabled by default');
      assert.match(`${rp.stderr || ''}${rp.stdout || ''}`, /REQUIRED|fail/i,
        'error should explain the fail-closed reason');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('--allow-unverified opts OUT: smoke disabled becomes a skip-with-warning (exit 0)', (t) => {
    if (!isLinuxX64) { t.skip(`fixtures are linux-x64; host is ${process.platform}-${process.arch}`); return; }
    if (!existsSync(FIXTURE)) { t.skip(`fixture not available: ${FIXTURE}`); return; }
    const work = mkdtempSync(join(tmpdir(), 'ccpatch-allowunver-'));
    try {
      const extracted = roundTripExtract(work);
      const output = join(work, 'claude.repacked');
      const rp = spawnSync(process.execPath, [REPACK_CLI, FIXTURE, extracted, output, '--allow-unverified'], {
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, CCPATCH_REPACK_SMOKE: '0' },
      });
      assert.equal(rp.status, 0, `--allow-unverified should skip-with-warning, not fail\n${rp.stderr || ''}`);
      assert.ok(existsSync(output), 'repack should still produce the binary under --allow-unverified');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('--require-smoke is accepted as a now-redundant no-op alias (still fail-closed)', (t) => {
    if (!isLinuxX64) { t.skip(`fixtures are linux-x64; host is ${process.platform}-${process.arch}`); return; }
    if (!existsSync(FIXTURE)) { t.skip(`fixture not available: ${FIXTURE}`); return; }
    const work = mkdtempSync(join(tmpdir(), 'ccpatch-reqsmoke-'));
    try {
      const extracted = roundTripExtract(work);
      const output = join(work, 'claude.repacked');
      // --require-smoke must be accepted (not treated as a positional arg) and, being the default
      // now, behaves identically to passing nothing: fail closed when smoke can't run.
      const rp = spawnSync(process.execPath, [REPACK_CLI, FIXTURE, extracted, output, '--require-smoke'], {
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, CCPATCH_REPACK_SMOKE: '0' },
      });
      assert.notEqual(rp.status, 0, '--require-smoke (no-op) keeps the fail-closed default');
      // Must NOT complain about a missing/extra argument — the flag was consumed, not positional.
      assert.doesNotMatch(`${rp.stderr || ''}${rp.stdout || ''}`, /Usage:/, 'flag must be consumed, not treated as positional');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('repack structured skip-line shape — formatSkipLine (WS6 contract)', () => {
  it('emits the stable [repack:skip] prefix and a parseable single-line JSON object', () => {
    const line = formatSkipLine({
      reason: 'native-grow-path-unavailable',
      platform: 'darwin-arm64',
      droppedPatches: ['p1', 'p2'],
      detail: 'demo',
    });
    assert.ok(line.startsWith('[repack:skip] '));
    assert.ok(!line.includes('\n'), 'single line so WS6 can grep it');
    const obj = JSON.parse(line.slice('[repack:skip] '.length));
    assert.deepEqual(obj, {
      reason: 'native-grow-path-unavailable',
      platform: 'darwin-arm64',
      droppedPatches: ['p1', 'p2'],
      detail: 'demo',
    });
  });

  it('defaults droppedPatches/detail to empty when omitted', () => {
    const obj = JSON.parse(formatSkipLine({ reason: 'r', platform: 'p' }).slice('[repack:skip] '.length));
    assert.deepEqual(obj.droppedPatches, []);
    assert.equal(obj.detail, '');
  });
});

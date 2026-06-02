// WS6 Item 8: native grow-path platform-degradation surfacing.
//
// Covers the tolerant [repack:skip] parser, the host grow-path capability
// helper, and the human-facing message formatter that doctor + the build path
// share. The doctor path itself is exercised end-to-end by driving runDoctorCore
// with a synthetic patch registry and asserting it reports the platform line.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRepackSkip,
  nativeGrowPathAvailable,
  hostPlatformLabel,
  formatPlatformDegradation,
} from '../runner/cli/native-profile.mjs';
import { runDoctorCore } from '../runner/cli/cmd-doctor.mjs';

describe('parseRepackSkip — tolerant [repack:skip] parser', () => {
  it('returns null when no marker is present', () => {
    assert.equal(parseRepackSkip('just some log output'), null);
    assert.equal(parseRepackSkip(''), null);
    assert.equal(parseRepackSkip(null), null);
  });

  it('parses the documented canonical shape', () => {
    const line =
      '[repack:skip] {"reason":"native-grow-path-unavailable",' +
      '"platform":"darwin-arm64","droppedPatches":["esm_compat","bun_shim","debug"]}';
    const s = parseRepackSkip(line);
    assert.equal(s.reason, 'native-grow-path-unavailable');
    assert.equal(s.platform, 'darwin-arm64');
    assert.deepEqual(s.droppedPatches, ['esm_compat', 'bun_shim', 'debug']);
  });

  it('tolerates prefix text and trailing junk after the JSON object', () => {
    const line = 'noise here [repack:skip] {"platform":"win32-x64","dropped":["a"]} and more noise';
    const s = parseRepackSkip(line);
    assert.equal(s.platform, 'win32-x64');
    assert.deepEqual(s.droppedPatches, ['a']);
  });

  it('tolerates alternate field names (dropped / patches / target / host)', () => {
    const s1 = parseRepackSkip('[repack:skip] {"target":"darwin-x64","patches":["x","y"]}');
    assert.equal(s1.platform, 'darwin-x64');
    assert.deepEqual(s1.droppedPatches, ['x', 'y']);

    const s2 = parseRepackSkip('[repack:skip] {"host":"linux-arm64","droppedPatchNames":"solo"}');
    assert.equal(s2.platform, 'linux-arm64');
    assert.deepEqual(s2.droppedPatches, ['solo']);
  });

  it('picks the LAST skip line when several are present', () => {
    const text =
      '[repack:skip] {"platform":"darwin-arm64","dropped":["old"]}\n' +
      'unrelated\n' +
      '[repack:skip] {"platform":"win32-x64","dropped":["new"]}\n';
    const s = parseRepackSkip(text);
    assert.equal(s.platform, 'win32-x64');
    assert.deepEqual(s.droppedPatches, ['new']);
  });

  it('returns a best-effort object when the marker is present but JSON is garbage', () => {
    const s = parseRepackSkip('[repack:skip] not-json-at-all');
    assert.notEqual(s, null);
    assert.equal(s.reason, 'native-grow-path-unavailable');
    assert.deepEqual(s.droppedPatches, []);
  });

  it('does not swallow JSON from a following log line', () => {
    const text = '[repack:skip] no-json-here\n{"platform":"should-not-be-read"}';
    const s = parseRepackSkip(text);
    assert.equal(s.platform, null);
  });
});

describe('nativeGrowPathAvailable — host capability', () => {
  it('is true only for linux-x64', () => {
    assert.equal(nativeGrowPathAvailable('linux', 'x64'), true);
    assert.equal(nativeGrowPathAvailable('darwin', 'arm64'), false);
    assert.equal(nativeGrowPathAvailable('darwin', 'x64'), false);
    assert.equal(nativeGrowPathAvailable('win32', 'x64'), false);
    assert.equal(nativeGrowPathAvailable('linux', 'arm64'), false);
  });
});

describe('formatPlatformDegradation — message format', () => {
  it('names the count, platform, reason, and patch names', () => {
    const msg = formatPlatformDegradation({
      platform: 'darwin-arm64',
      droppedPatches: ['esm_compat', 'bun_shim', 'debug'],
    });
    assert.match(msg, /3 patch\(es\) skipped/);
    assert.match(msg, /darwin-arm64/);
    assert.match(msg, /Mach-O/);
    assert.match(msg, /esm_compat, bun_shim, debug/);
  });

  it('uses a count-less variant when no patch names are known', () => {
    const msg = formatPlatformDegradation({ platform: 'darwin-arm64', droppedPatches: [] });
    assert.match(msg, /Patches may be skipped/);
    assert.match(msg, /darwin-arm64/);
  });

  it('falls back to the host label when platform is absent', () => {
    const msg = formatPlatformDegradation({ droppedPatches: ['a'] });
    assert.match(msg, new RegExp(hostPlatformLabel().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  });
});

// ── doctor end-to-end: platform reporting ───────────────────────────────────

function writeBundle(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-ws6-'));
  const p = path.join(dir, 'cli.js');
  fs.writeFileSync(p, body);
  // doctor reads ccpatch.yml from cwd; an empty registry => "all enabled".
  return { p, dir };
}

function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => lines.push('ERR ' + a.join(' ')),
  };
}

describe('runDoctorCore — surfaces native platform reachability', () => {
  it('reports a [native] line driven by an injected [repack:skip]', async () => {
    const { p } = writeBundle('#!/usr/bin/env node\nconsole.log(1);\n');
    const logger = captureLogger();
    const prev = process.env.CCPATCH_REPACK_SKIP;
    process.env.CCPATCH_REPACK_SKIP =
      '[repack:skip] {"platform":"darwin-arm64","droppedPatches":["esm_compat","bun_shim"]}';
    try {
      // Empty patch registry: no anchors to probe, doctor still runs the report.
      await runDoctorCore({ inputPath: p, profile: null }, {}, logger);
    } finally {
      if (prev === undefined) delete process.env.CCPATCH_REPACK_SKIP;
      else process.env.CCPATCH_REPACK_SKIP = prev;
    }
    const out = logger.lines.join('\n');
    assert.match(out, /\[native\] 2 patch\(es\) skipped/);
    assert.match(out, /darwin-arm64/);
    assert.match(out, /esm_compat, bun_shim/);
  });

  it('reports grow-path availability from the host when no skip line is present', async () => {
    const { p } = writeBundle('#!/usr/bin/env node\nconsole.log(1);\n');
    const logger = captureLogger();
    const prev = process.env.CCPATCH_REPACK_SKIP;
    delete process.env.CCPATCH_REPACK_SKIP;
    try {
      await runDoctorCore({ inputPath: p, profile: null }, {}, logger);
    } finally {
      if (prev !== undefined) process.env.CCPATCH_REPACK_SKIP = prev;
    }
    const out = logger.lines.join('\n');
    // The message differs by host, but a [native] line is always emitted and
    // names the host platform label.
    assert.match(out, /\[native\]/);
    assert.match(out, new RegExp(hostPlatformLabel().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  });
});

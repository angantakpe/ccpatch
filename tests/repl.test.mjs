/**
 * tests/repl.test.mjs — exercise `ccpatch repl` end-to-end against a tiny
 * fixture bundle that publishes one contract into __ccpRegistry.
 *
 * Uses the in-process runRepl() with PassThrough streams instead of shelling
 * out to the bin/ entry, so we can assert on stdout chunk-by-chunk.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { runRepl } from '../tools/repl.mjs';
import { parsePatchCliArgs, runReplCommand } from '../runner/cli.mjs';

// Tiny fixture bundle. Boots the contracts kernel inline (same hook
// core/contracts.mjs injects at apply-time), then publishes one contract
// via __ccpProvide. After registration, the script ends — the child stays
// alive because tools/repl-child.mjs keeps a stdin handler attached.
const FIXTURE_BUNDLE = `
if (!globalThis.__ccpRegistry) {
  globalThis.__ccpRegistry = new Map();
  globalThis.__ccpProvide = function (name, spec) {
    globalThis.__ccpRegistry.set(name, {
      name, version: (spec.version|0)||1,
      producer: spec.producer || '<unknown>',
      shape: Array.isArray(spec.shape) ? spec.shape.slice() : [],
      value: spec.value,
    });
    return spec.value;
  };
  globalThis.__ccpInspectContracts = function () {
    var out = [];
    globalThis.__ccpRegistry.forEach(function (entry, name) {
      out.push({ name, version: entry.version, producer: entry.producer, shape: entry.shape.slice() });
    });
    return out;
  };
}
globalThis.__ccpProvide('answer', {
  producer: 'fixture',
  version: 1,
  value: () => 42,
});
`;

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-repl-'));
  const p = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(p, FIXTURE_BUNDLE, 'utf8');
  return { dir, path: p };
}

/**
 * Drive runRepl() with a scripted sequence of input lines. Returns the
 * concatenated stdout string. Waits between lines to let the eval roundtrip.
 */
async function driveRepl(bundlePath, lines, { perLineWait = 200 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  let captured = '';
  output.on('data', d => { captured += d; });

  const replPromise = runRepl(bundlePath, { input, output, prompt: '' });

  // Wait for the initial banner.
  await waitFor(() => captured.includes('__ccpRegistry') || captured.includes('no ccpatch'), 3000);

  for (const line of lines) {
    input.write(line + '\n');
    if (line.trim() === ':quit' || line.trim() === ':q') break;
    await sleep(perLineWait);
  }
  input.end();
  await replPromise;
  return captured;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
}

describe('ccpatch repl', () => {
  it('boots, sees the registered contract, and evaluates expressions', async () => {
    const fx = writeFixture();
    try {
      const out = await driveRepl(fx.path, [
        '1 + 1',
        'globalThis.__ccpRegistry.get("answer").value()',
        ':quit',
      ]);
      assert.match(out, /__ccpRegistry: 1 entries/);
      assert.match(out, /answer\s+producer=fixture/);
      assert.match(out, /\b2\b/);
      // No __ccpRequire in the minimal fixture, so the second expr returns 42.
      assert.match(out, /\b42\b/);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it(':list returns the registered names', async () => {
    const fx = writeFixture();
    try {
      const out = await driveRepl(fx.path, [':list', ':quit']);
      assert.match(out, /answer/);
      assert.match(out, /fixture/);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it(':reload respawns and the registry survives', async () => {
    const fx = writeFixture();
    try {
      const out = await driveRepl(fx.path, [':reload', ':list', ':quit'], { perLineWait: 400 });
      assert.match(out, /\[reloaded\] __ccpRegistry: 1 entries/);
      assert.match(out, /answer/);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('eval timeout: long-running expression kills the child and reports error', async () => {
    const fx = writeFixture();
    try {
      // 8s busy loop — exceeds 5s timeout.
      const out = await driveRepl(fx.path, [
        'await new Promise(r => setTimeout(r, 8000))',
        '1 + 1',
        ':quit',
      ], { perLineWait: 6000 });
      assert.match(out, /timed out|child not running|error:/);
      // After respawn, REPL still usable — `1 + 1` should yield 2.
      assert.match(out, /\b2\b/);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('rejects binary targets via runReplCommand', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-repl-bin-'));
    const p = path.join(dir, 'evil.exe');
    // 4-byte PE magic. isBinaryTarget sniffs .exe AND magic bytes.
    fs.writeFileSync(p, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
    let exitCode;
    const errors = [];
    const logger = {
      log: () => {},
      warn: () => {},
      error: (...a) => errors.push(a.join(' ')),
    };
    try {
      exitCode = await runReplCommand({ patchedPath: p }, logger);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.notEqual(exitCode, 0);
    assert.match(errors.join('\n'), /only supports JavaScript bundles/);
  });

  it('parses `repl <patched.js>` from CLI args', () => {
    const opts = parsePatchCliArgs(['repl', '/tmp/x.mjs']);
    assert.equal(opts.repl, true);
    assert.equal(path.basename(opts.patchedPath), 'x.mjs');
  });

  it('reports a friendly message when bundle has no __ccpRegistry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-repl-empty-'));
    const p = path.join(dir, 'empty.mjs');
    fs.writeFileSync(p, '// no registry\n', 'utf8');
    try {
      const out = await driveRepl(p, ['1 + 1', ':quit']);
      assert.match(out, /no ccpatch contracts registered/);
      assert.match(out, /\b2\b/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

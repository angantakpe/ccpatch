/**
 * sea-extraction.test.mjs
 *
 * Unit tests for the Bun-SEA completeness work (architecture item #3):
 *   1. The module-marker parser against a small SYNTHETIC Bun-SEA fixture binary
 *      constructed in-test (a doubled-path JS module + a native ELF module).
 *      No real Anthropic bundle content is used or committed — the on-disk
 *      marker format is reproduced synthetically.
 *   2. buildEmbeddedManifest() shape + writeEmbeddedArtifacts() output (manifest
 *      file + extracted embedded/ tree, with sha256 integrity).
 *   3. The loud-but-fail-open require shim injected by esm-compat.mjs: an
 *      embedded-and-extracted module resolves from ./embedded; an
 *      embedded-but-missing module throws a SPECIFIC actionable error while
 *      preserving the original err.code; a non-embedded module (ws) propagates
 *      the ORIGINAL error untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

import { parseModules, getModuleSlice } from '../tools/bun-decompiler/decompile.mjs';
import { buildEmbeddedManifest, writeEmbeddedArtifacts } from '../bin/extract-from-binary.mjs';
import { applyEsmCompatibilityShim } from '../runner/shims/esm-compat.mjs';

const require = createRequire(import.meta.url);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Synthetic Bun-SEA fixture builder ────────────────────────────────────────
// Reproduces the marker layout reversed in bin/extract-from-binary.mjs:
//   JS (doubled):  /$bunfs/root/<p>\0/$bunfs/root/<p>\0// @bun <flags>\n<wrapper>\0
//   native (.node): /$bunfs/root/<p>\0<ELF image bytes>   (runs to next marker/EOF)
function bunfs(p) { return Buffer.from('/$bunfs/root/' + p); }
const NUL = Buffer.from([0]);

function makeJsModule(p, body) {
  const wrapper = Buffer.from(
    `(function(exports, require, module, __filename, __dirname) {${body}})`,
  );
  const header = Buffer.from('// @bun @bytecode @bun-cjs\n');
  // Doubled-path form (bytecode-backed), exactly as observed in real binaries.
  return Buffer.concat([bunfs(p), NUL, bunfs(p), NUL, header, wrapper, NUL]);
}

function makeNativeModule(p, payload) {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(payload)]);
  return Buffer.concat([bunfs(p), NUL, elf]);
}

function buildSyntheticSea() {
  return Buffer.concat([
    Buffer.from('SEA-HEADER-PADDING-NOT-A-MARKER'),
    makeJsModule('src/entrypoints/cli.js', 'module.exports="Claude Code synthetic";'),
    makeJsModule('audio-capture.js', 'module.exports=require("/$bunfs/root/audio-capture.node");'),
    // Native module is placed LAST so its content slice runs to EOF.
    makeNativeModule('audio-capture.node', 'SYNTHETIC-NATIVE-ADDON-BYTES'),
  ]);
}

// ── 1. Marker / header parser ────────────────────────────────────────────────

test('parseModules finds JS + native entries in a synthetic SEA', () => {
  const buf = buildSyntheticSea();
  const { modules } = parseModules(buf);
  const byPath = Object.fromEntries(modules.map((m) => [m.path, m]));

  assert.ok(byPath['src/entrypoints/cli.js'], 'entrypoint JS module found');
  assert.equal(byPath['src/entrypoints/cli.js'].kind, 'js');
  assert.ok(byPath['audio-capture.js'], 'wrapper JS module found');
  assert.equal(byPath['audio-capture.js'].kind, 'js');
  assert.ok(byPath['audio-capture.node'], 'native module found');
  assert.equal(byPath['audio-capture.node'].kind, 'elf');

  // The native slice must be the raw ELF image (magic preserved, no NUL trim).
  const nativeSlice = getModuleSlice(buf, byPath['audio-capture.node'], { unwrap: false });
  assert.deepEqual(nativeSlice.slice(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
});

test('parser ignores require("/$bunfs/root/*.node") string literals (no false module)', () => {
  // The audio-capture.js wrapper body contains a /$bunfs/root/ literal; it must
  // NOT be mis-parsed as its own module header.
  const buf = buildSyntheticSea();
  const { modules } = parseModules(buf);
  // Exactly three real modules; the literal inside the wrapper is not a 4th.
  assert.equal(modules.length, 3);
});

// ── 2. Manifest shape + writer ───────────────────────────────────────────────

test('buildEmbeddedManifest yields {path,kind,offset,size,sha256} per entry', () => {
  const buf = buildSyntheticSea();
  const { manifest } = buildEmbeddedManifest(buf);
  assert.equal(manifest.length, 3);
  for (const e of manifest) {
    assert.ok(typeof e.path === 'string' && e.path.length > 0);
    assert.ok(e.kind === 'js' || e.kind === 'elf');
    assert.ok(Number.isInteger(e.offset) && e.offset >= 0);
    assert.ok(Number.isInteger(e.size) && e.size > 0);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
  }
});

test('writeEmbeddedArtifacts writes manifest + embedded/ tree with matching sha256', () => {
  const buf = buildSyntheticSea();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-sea-'));
  try {
    const outputPath = path.join(dir, 'cli.v0.0.0.cjs');
    const manifest = writeEmbeddedArtifacts(buf, outputPath);

    // Manifest file exists next to the (notional) cli.js output.
    const manifestPath = path.join(dir, 'embedded-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'embedded-manifest.json written');
    const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(onDisk, manifest);

    // The entrypoint is NOT re-extracted; the wrapper + native module ARE.
    assert.ok(!fs.existsSync(path.join(dir, 'embedded', 'src/entrypoints/cli.js')));
    const wrapperPath = path.join(dir, 'embedded', 'audio-capture.js');
    const nativePath = path.join(dir, 'embedded', 'audio-capture.node');
    assert.ok(fs.existsSync(wrapperPath), 'wrapper extracted');
    assert.ok(fs.existsSync(nativePath), 'native addon extracted');

    // Extracted bytes match the manifest sha256.
    const nativeEntry = manifest.find((e) => e.path === 'audio-capture.node');
    assert.equal(sha256(fs.readFileSync(nativePath)), nativeEntry.sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. Loud-but-fail-open require shim ───────────────────────────────────────

// Reconstruct the injected __hm_require (+ its manifest helpers) from the real
// esm-compat shim output and return a callable bound to a mock native require
// and a controlled bundle directory. This exercises the ACTUAL injected code.
function buildRequireShim({ nativeRequire, bundleDir }) {
  const out = applyEsmCompatibilityShim(
    '(function(exports, require, module, __filename, __dirname) {var x=1;})(module.exports, require, module, __filename, __dirname);',
  );
  const start = out.indexOf('let __hm_embeddedSet = null;');
  const end = out.indexOf('__hm_require.resolve = __hm_nativeRequire.resolve;');
  assert.ok(start !== -1 && end !== -1 && end > start, 'require shim region located in esm-compat output');
  const snippet = out.slice(start, end);
  // Shadow globalThis so __hm_require's react/ink fast-paths are inert here.
  const fn = new Function(
    '__hm_nativeRequire',
    '__hm_dirname',
    'globalThis',
    `${snippet}\nreturn __hm_require;`,
  );
  return fn(nativeRequire, bundleDir, { __hm_react: 'R', __hm_ink: 'I' });
}

function notFound(id) {
  const e = new Error(`Cannot find module '${id}'`);
  e.code = 'MODULE_NOT_FOUND';
  return e;
}

test('require shim: embedded + extracted module resolves from ./embedded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-shim-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'embedded-manifest.json'),
      JSON.stringify([{ path: 'audio-capture.js', kind: 'js', offset: 0, size: 1, sha256: 'x' }]),
    );
    fs.mkdirSync(path.join(dir, 'embedded'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'embedded', 'audio-capture.js'), 'module.exports={ok:true};');

    const nativeRequire = (id) => {
      if (id === 'node:path') return require('node:path');
      if (id === 'node:fs') return require('node:fs');
      if (typeof id === 'string' && path.isAbsolute(id)) return require(id);
      throw notFound(id);
    };

    const __hm_require = buildRequireShim({ nativeRequire, bundleDir: dir });
    const mod = __hm_require('audio-capture.js');
    assert.deepEqual(mod, { ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('require shim: embedded-but-not-extracted throws a specific error, code preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-shim-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'embedded-manifest.json'),
      JSON.stringify([{ path: 'image-processor.node', kind: 'elf', offset: 0, size: 1, sha256: 'x' }]),
    );
    // NOTE: no embedded/ dir — simulates an incomplete extraction.

    const nativeRequire = (id) => {
      if (id === 'node:path') return require('node:path');
      if (id === 'node:fs') return require('node:fs');
      throw notFound(id);
    };

    const __hm_require = buildRequireShim({ nativeRequire, bundleDir: dir });
    assert.throws(
      () => __hm_require('image-processor.node'),
      (err) => {
        assert.equal(err.code, 'MODULE_NOT_FOUND', 'original error code preserved');
        assert.match(err.message, /embedded in the Bun SEA but was not extracted/);
        assert.match(err.message, /re-run extraction/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('require shim: non-embedded module (ws) propagates the ORIGINAL error untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-shim-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'embedded-manifest.json'),
      JSON.stringify([{ path: 'audio-capture.node', kind: 'elf', offset: 0, size: 1, sha256: 'x' }]),
    );

    const original = notFound('ws');
    const nativeRequire = (id) => {
      if (id === 'node:path') return require('node:path');
      if (id === 'node:fs') return require('node:fs');
      if (id === 'ws') throw original;
      throw notFound(id);
    };

    const __hm_require = buildRequireShim({ nativeRequire, bundleDir: dir });
    assert.throws(
      () => __hm_require('ws'),
      (err) => {
        assert.equal(err, original, 'exact same error object re-thrown');
        assert.equal(err.code, 'MODULE_NOT_FOUND');
        assert.doesNotMatch(err.message, /embedded in the Bun SEA/, 'message NOT augmented for non-embedded module');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('require shim: missing manifest is fail-open (plain not-found, no crash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-shim-'));
  try {
    // No embedded-manifest.json at all — older extraction.
    const original = notFound('some-pkg');
    const nativeRequire = (id) => {
      if (id === 'node:path') return require('node:path');
      if (id === 'node:fs') return require('node:fs');
      if (id === 'some-pkg') throw original;
      throw notFound(id);
    };
    const __hm_require = buildRequireShim({ nativeRequire, bundleDir: dir });
    assert.throws(
      () => __hm_require('some-pkg'),
      (err) => {
        assert.equal(err, original);
        assert.doesNotMatch(err.message, /embedded in the Bun SEA/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

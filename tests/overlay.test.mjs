import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

import { buildOverlay, writeOverlay } from '../runner/overlay-builder.mjs';
import { validateManifest } from '../runner/manifest.mjs';
import overlayLoader from '../core/overlay_loader.mjs';

function mkPatch(extra) {
  return {
    description: 'test',
    verify: { present: 'x', weak: true },
    apply: (c) => c + 'x',
    ...extra,
  };
}

describe('buildOverlay', () => {
  it('returns null when no patch declares overlay', () => {
    const patches = { a: mkPatch(), b: mkPatch() };
    assert.equal(buildOverlay(patches, ['a', 'b']), null);
  });

  it('emits __ccpProvide blocks for every overlay-opt-in patch', () => {
    const patches = {
      alpha: mkPatch({
        overlay: { register: 'alpha-svc', code: `return { kind: 'a' };` },
      }),
      beta: mkPatch({
        overlay: { register: 'beta-svc', code: `return { kind: 'b' };` },
      }),
    };
    const src = buildOverlay(patches, ['alpha', 'beta']);
    assert.ok(src.includes('alpha-svc'), 'missing alpha register name');
    assert.ok(src.includes('beta-svc'), 'missing beta register name');
    assert.ok(src.includes(`return { kind: 'a' };`), 'missing alpha code');
    assert.ok(src.includes(`return { kind: 'b' };`), 'missing beta code');
    assert.match(src, /__ccpProvide\(/);
  });

  it('produces output that node --check accepts as valid JS', () => {
    const patches = {
      alpha: mkPatch({
        overlay: { register: 'alpha-svc', code: `return { hello: 'world' };` },
      }),
      beta: mkPatch({
        overlay: { register: 'beta-svc', code: `const n = 1 + 2; return n;` },
      }),
    };
    const src = buildOverlay(patches, ['alpha', 'beta']);
    const tmp = path.join(os.tmpdir(), `ccp-overlay-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, src, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('writeOverlay writes to <outputDir>/ccpatch-overlay.mjs and returns the path', () => {
    const patches = {
      alpha: mkPatch({
        overlay: { register: 'alpha-svc', code: `return 1;` },
      }),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-overlay-'));
    try {
      const out = writeOverlay(patches, ['alpha'], dir);
      assert.equal(out, path.join(dir, 'ccpatch-overlay.mjs'));
      assert.ok(fs.existsSync(out));
      assert.ok(fs.readFileSync(out, 'utf8').includes('alpha-svc'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeOverlay returns null and writes nothing when no patches opt in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-overlay-'));
    try {
      const out = writeOverlay({ a: mkPatch() }, ['a'], dir);
      assert.equal(out, null);
      assert.equal(fs.existsSync(path.join(dir, 'ccpatch-overlay.mjs')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('overlay_loader patch', () => {
  it('injects exactly one require for ccpatch-overlay.mjs at the CJS-IIFE anchor', () => {
    const bundle =
      '#!/usr/bin/env node\n' +
      '(function(exports, require, module, __filename, __dirname) { return 1; })' +
      '(module.exports, require, module, __filename, __dirname);\n';
    const out = overlayLoader.apply(bundle, {});
    assert.notEqual(out, bundle, 'apply() did not change the bundle');
    assert.ok(out.includes(`require('./ccpatch-overlay.mjs')`), 'missing require');
    assert.ok(out.includes('[ccpatch overlay-loader]'), 'missing sentinel comment');

    // Idempotent: second apply leaves the bundle alone.
    const out2 = overlayLoader.apply(out, {});
    assert.equal(out2, out, 'apply() is not idempotent');
  });

  it('declares the fs capability and pre phase', () => {
    assert.deepEqual(overlayLoader.capabilities, ['fs']);
    assert.equal(overlayLoader.phase, 'pre');
    assert.equal(overlayLoader.required, true);
  });
});

describe('loader + overlay roundtrip', () => {
  it('running the generated overlay registers names into a fake __ccpRegistry', () => {
    const patches = {
      alpha: mkPatch({
        overlay: { register: 'alpha-svc', code: `return { kind: 'a' };` },
      }),
      beta: mkPatch({
        overlay: { register: 'beta-svc', code: `return { kind: 'b' };` },
      }),
    };
    const src = buildOverlay(patches, ['alpha', 'beta']);

    const registry = new Map();
    const ctx = {
      console: { log() {}, warn() {}, error() {} },
    };
    ctx.globalThis = ctx;
    ctx.__ccpProvide = function (name, spec) {
      registry.set(name, { producer: spec.producer, value: spec.value });
    };
    // Wrap the overlay file (which uses top-level `globalThis.__ccpProvide`)
    // in a small adapter so VM execution sees our stub.
    vm.createContext(ctx);
    new vm.Script(src).runInContext(ctx);

    assert.ok(registry.has('alpha-svc'));
    assert.ok(registry.has('beta-svc'));
    assert.equal(registry.get('alpha-svc').producer, 'alpha');
    assert.equal(registry.get('beta-svc').producer, 'beta');
    assert.equal(registry.get('alpha-svc').value.kind, 'a');
    assert.equal(registry.get('beta-svc').value.kind, 'b');
  });
});

describe('manifest validation — overlay field', () => {
  it('accepts a valid overlay', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
      apply: () => '',
      overlay: { register: 'svc', code: 'return 1;' },
    };
    const { ok, errors, normalized } = validateManifest(mod, 'svc.mjs');
    assert.equal(ok, true, `unexpected errors: ${errors}`);
    assert.deepEqual(normalized.overlay, { register: 'svc', code: 'return 1;' });
  });

  it('rejects overlay missing register', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
      apply: () => '',
      overlay: { code: 'return 1;' },
    };
    const { ok, errors } = validateManifest(mod, 'svc.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('overlay.register')), `errors: ${errors}`);
  });

  it('rejects overlay missing code', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
      apply: () => '',
      overlay: { register: 'svc' },
    };
    const { ok, errors } = validateManifest(mod, 'svc.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('overlay.code')), `errors: ${errors}`);
  });

  it('rejects overlay with empty register string', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
      apply: () => '',
      overlay: { register: '', code: 'return 1;' },
    };
    const { ok, errors } = validateManifest(mod, 'svc.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('overlay.register')), `errors: ${errors}`);
  });
});

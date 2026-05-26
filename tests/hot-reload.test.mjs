import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  buildOverlay,
  emitOverlay,
  writeOverlay,
} from '../runner/overlay-builder.mjs';
import { makeWatchLoop } from '../runner/cli.mjs';

const require = createRequire(import.meta.url);

function mkPatch(extra) {
  return {
    description: 'test',
    verify: { present: 'x', weak: true },
    apply: (c) => c + 'x',
    ...extra,
  };
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('hot-reload: dev-mode overlay format', () => {
  it('non-dev mode emits the inline-code overlay (regression vs Wave 3C)', () => {
    const patches = {
      alpha: mkPatch({
        overlay: { register: 'alpha-svc', code: `return { kind: 'a' };` },
      }),
    };
    const src = buildOverlay(patches, ['alpha']);
    assert.ok(src.includes(`return { kind: 'a' };`), 'inline code should be wrapped');
    assert.match(src, /\(function \(\) \{/);
    assert.ok(!src.includes('ccpatch-overlay-shims'), 'non-dev should not reference shim dir');
    assert.ok(!src.includes('new Proxy'), 'non-dev should not emit Proxy');
  });

  it('dev mode emits a thin Proxy loader (no inline IIFE)', () => {
    const patches = {
      alpha: mkPatch({
        overlay: { register: 'alpha-svc', code: `module.exports = { kind: 'a' };` },
      }),
    };
    const src = buildOverlay(patches, ['alpha'], { dev: true });
    assert.ok(src.includes('new Proxy'), 'dev should emit Proxy');
    assert.ok(src.includes('ccpatch-overlay-shims'), 'dev should reference shim dir');
    assert.ok(src.includes('delete require.cache'), 'dev should bust require.cache');
    assert.ok(!src.includes(`module.exports = { kind: 'a' };`), 'dev should not inline shim code');
  });

  it('emitOverlay --dev writes per-patch shim files and a thin loader', () => {
    const dir = mkTmp('ccp-dev-emit-');
    try {
      const patches = {
        cost_tracker: mkPatch({
          overlay: { register: 'cost-tracker', code: `module.exports = { hello() { return 1; } };` },
        }),
        expose_tool_dispatch: mkPatch({
          overlay: { register: 'tool-dispatch', code: `module.exports = { v: 2 };` },
        }),
      };
      const r = emitOverlay(patches, ['cost_tracker', 'expose_tool_dispatch'], dir, { dev: true });
      assert.ok(r);
      assert.equal(r.overlayPath, path.join(dir, 'ccpatch-overlay.mjs'));
      assert.equal(r.shimDir, path.join(dir, 'ccpatch-overlay-shims'));
      assert.equal(r.shimPaths.length, 2);
      assert.ok(fs.existsSync(path.join(dir, 'ccpatch-overlay-shims', 'cost_tracker.cjs')));
      assert.ok(fs.existsSync(path.join(dir, 'ccpatch-overlay-shims', 'expose_tool_dispatch.cjs')));
      const overlay = fs.readFileSync(r.overlayPath, 'utf8');
      assert.match(overlay, /Proxy/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emitOverlay (prod) returns no shimDir and only one overlay file', () => {
    const dir = mkTmp('ccp-prod-emit-');
    try {
      const patches = {
        alpha: mkPatch({
          overlay: { register: 'alpha-svc', code: `return 1;` },
        }),
      };
      const r = emitOverlay(patches, ['alpha'], dir);
      assert.ok(r);
      assert.equal(r.shimDir, null);
      assert.equal(r.shimPaths.length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'ccpatch-overlay-shims')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeOverlay back-compat: still returns the overlay path (non-dev)', () => {
    const dir = mkTmp('ccp-bc-');
    try {
      const patches = { a: mkPatch({ overlay: { register: 's', code: 'return 1;' } }) };
      const out = writeOverlay(patches, ['a'], dir);
      assert.equal(out, path.join(dir, 'ccpatch-overlay.mjs'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hot-reload: modifying a shim file is picked up by re-require', () => {
  it('Proxy property access re-requires the shim from disk', () => {
    const dir = mkTmp('ccp-hot-');
    try {
      const patches = {
        myshim: mkPatch({
          overlay: { register: 'my-svc', code: `module.exports = { value: () => 'v1' };` },
        }),
      };
      const r = emitOverlay(patches, ['myshim'], dir, { dev: true });
      assert.ok(r);
      const shimPath = path.join(dir, 'ccpatch-overlay-shims', 'myshim.cjs');

      // Simulate the overlay's Proxy by hand using a real createRequire.
      // (We avoid evaluating the overlay file itself because it expects
      // __ccpProvide and `require`/__dirname from a CJS scope.)
      const localRequire = createRequire(path.join(dir, 'overlay-stub.cjs'));
      const proxy = new Proxy({}, {
        get(_t, prop) {
          try { delete localRequire.cache[localRequire.resolve(shimPath)]; } catch (_) {}
          const mod = localRequire(shimPath);
          const v = mod && typeof mod === 'object' ? mod[prop] : undefined;
          return typeof v === 'function' ? v.bind(mod) : v;
        },
      });

      assert.equal(proxy.value(), 'v1');

      // Edit the shim file on disk.
      const newContent = `module.exports = { value: () => 'v2-EDITED' };\n`;
      fs.writeFileSync(shimPath, newContent, 'utf8');

      // Next access must reflect the new content.
      assert.equal(proxy.value(), 'v2-EDITED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hot-reload: watch loop debounces rapid bursts', () => {
  it('a 5-write burst within the debounce window produces exactly one re-emit', async () => {
    const dir = mkTmp('ccp-watch-');
    try {
      const patches = {
        burst: mkPatch({
          overlay: { register: 'burst-svc', code: `module.exports = { n: 1 };` },
        }),
      };
      emitOverlay(patches, ['burst'], dir, { dev: true });

      const loop = makeWatchLoop({
        patches,
        names: ['burst'],
        outputDir: dir,
        debounceMs: 200,
        logger: { log() {}, warn() {}, error() {} },
      });

      // Simulate 5 rapid fs events.
      for (let i = 0; i < 5; i++) loop.trigger(`evt-${i}`);
      // None should have fired yet.
      assert.equal(loop.getReEmitCount(), 0);

      await loop.drain();
      assert.equal(loop.getReEmitCount(), 1, 'expected exactly one debounced re-emit');

      loop.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two separate bursts (> debounce apart) produce two re-emits', async () => {
    const dir = mkTmp('ccp-watch2-');
    try {
      const patches = {
        burst: mkPatch({
          overlay: { register: 'burst-svc', code: `module.exports = { n: 1 };` },
        }),
      };
      emitOverlay(patches, ['burst'], dir, { dev: true });

      const loop = makeWatchLoop({
        patches,
        names: ['burst'],
        outputDir: dir,
        debounceMs: 80,
        logger: { log() {}, warn() {}, error() {} },
      });

      loop.trigger('a'); loop.trigger('a');
      await loop.drain();
      loop.trigger('b'); loop.trigger('b');
      await loop.drain();
      assert.equal(loop.getReEmitCount(), 2);
      loop.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

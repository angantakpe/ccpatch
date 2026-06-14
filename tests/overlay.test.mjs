import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

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

  it('injects the agents-dir block AND the ADK-integrity gate (CJS path)', () => {
    const bundle =
      '#!/usr/bin/env node\n' +
      '(function(exports, require, module, __filename, __dirname) { return 1; })' +
      '(module.exports, require, module, __filename, __dirname);\n';
    const out = overlayLoader.apply(bundle, {});
    assert.ok(out.includes('[ccpatch agents-dir]'), 'missing agents-dir sentinel');
    assert.ok(out.includes('[ccpatch adk-integrity]'), 'missing adk-integrity sentinel');
    // The ADK gate reads ccpatch-adk and bails on mismatch (skip-all behavior).
    assert.ok(out.includes('ccpatch-adk'), 'agents-dir block does not reference ccpatch-adk');
    assert.ok(out.includes('Skipping ALL agent loads'), 'missing skip-all-on-tamper guard');
  });

  it('ESM fallback injects overlay AND agents-dir + ADK-integrity (not overlay-only)', () => {
    // A native-ESM bundle has the shebang but no CJS-IIFE anchor.
    const bundle = '#!/usr/bin/env node\nexport const x = 1;\n';
    const out = overlayLoader.apply(bundle, {});
    assert.notEqual(out, bundle, 'apply() did not change the ESM bundle');
    assert.ok(out.includes('[ccpatch overlay-loader]'), 'missing overlay sentinel');
    assert.ok(out.includes('[ccpatch agents-dir]'), 'ESM path dropped the agents-dir block');
    assert.ok(out.includes('[ccpatch adk-integrity]'), 'ESM path dropped the ADK-integrity gate');
    assert.ok(out.includes('createRequire'), 'ESM path must use createRequire');
    assert.ok(out.includes("import('node:url')") || out.includes('node:url'),
      'ESM agents-dir needs fileURLToPath for __dirname');

    // Idempotent on the ESM path too.
    const out2 = overlayLoader.apply(out, {});
    assert.equal(out2, out, 'ESM apply() is not idempotent');
  });

  it('verify lists both sentinels and the ADK-integrity marker', () => {
    const { verify } = overlayLoader;
    assert.ok(verify.present.includes('/* [ccpatch overlay-loader] */'));
    assert.ok(verify.present.includes('/* [ccpatch agents-dir] */'));
    assert.ok(verify.present.includes('/* [ccpatch adk-integrity] */'));
    assert.equal(verify.count.present, verify.present.length);
  });
});

// Execute the injected agents-dir block against a real tmp dir to prove the
// ADK-runtime integrity gate actually fires (fix: the runtime .sha256 sidecars
// were write-only). We extract the CJS hook, wrap it so it runs standalone with
// a controllable __dirname/require, and assert load/skip behavior.
describe('overlay_loader agents-dir ADK integrity gate (runtime)', () => {
  const realRequire = createRequire(import.meta.url);

  // Pull the agents-dir block out of a CJS-injected bundle.
  function extractAgentsBlock() {
    const bundle =
      '#!/usr/bin/env node\n' +
      '(function(exports, require, module, __filename, __dirname) { return 1; })' +
      '(module.exports, require, module, __filename, __dirname);\n';
    const out = overlayLoader.apply(bundle, {});
    const start = out.indexOf('/* [ccpatch agents-dir] */');
    assert.ok(start >= 0, 'agents-dir block not found');
    // The block is a single IIFE statement; everything from the sentinel to the
    // end of the injected hook (before the IIFE invocation line) is safe to run.
    // The agents-dir block is the last injected statement; take everything from
    // its sentinel to the end of the IIFE invocation (its closing `})();`).
    const tail = out.slice(start);
    const endMarker = '})();\n';
    const end = tail.lastIndexOf(endMarker) + endMarker.length;
    return tail.slice(0, end);
  }

  // Run the block with a fake __dirname = tmp, recording stderr writes.
  function runBlock(tmp) {
    const block = extractAgentsBlock();
    const logs = [];
    const fakeProcess = {
      ...process,
      stderr: { write: (s) => { logs.push(String(s)); return true; } },
    };
    const sandbox = {
      require: realRequire,
      __dirname: tmp,
      process: fakeProcess,
      console,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(block).runInContext(sandbox);
    return logs.join('');
  }

  function writeWithSidecar(file, body) {
    fs.writeFileSync(file, body, 'utf8');
    const hex = createHash('sha256').update(body, 'utf8').digest('hex');
    fs.writeFileSync(file + '.sha256', hex + '\n', 'utf8');
  }

  it('loads agents when the ADK runtime hashes match', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-int-'));
    try {
      fs.mkdirSync(path.join(tmp, 'ccpatch-adk'));
      fs.mkdirSync(path.join(tmp, 'ccpatch-agents'));
      writeWithSidecar(path.join(tmp, 'ccpatch-adk', 'index.mjs'), 'export const a=1;\n');
      // A side-effect agent stub (valid sync ESM) that writes a sentinel file
      // when loaded. Node >=20.19 lets require() pull in a TLA-free ESM module.
      const marker = path.join(tmp, 'LOADED');
      const stub =
        `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'yes');\n`;
      writeWithSidecar(path.join(tmp, 'ccpatch-agents', 'a.mjs'), stub);

      const logs = runBlock(tmp);
      assert.equal(fs.existsSync(marker), true,
        'agent stub was not loaded (logs: ' + logs + ')');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses ALL agents when an ADK runtime file is tampered', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-int-'));
    try {
      fs.mkdirSync(path.join(tmp, 'ccpatch-adk'));
      fs.mkdirSync(path.join(tmp, 'ccpatch-agents'));
      writeWithSidecar(path.join(tmp, 'ccpatch-adk', 'index.mjs'), 'export const a=1;\n');
      // Tamper: rewrite the runtime body WITHOUT updating its sidecar.
      fs.writeFileSync(path.join(tmp, 'ccpatch-adk', 'index.mjs'), 'export const a=2;//evil\n', 'utf8');

      const marker = path.join(tmp, 'LOADED');
      const stub = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes');\n`;
      writeWithSidecar(path.join(tmp, 'ccpatch-agents', 'a.mjs'), stub);

      const logs = runBlock(tmp);
      assert.equal(fs.existsSync(marker), false, 'agent loaded despite tampered ADK runtime');
      assert.match(logs, /INTEGRITY FAIL: ADK runtime hash mismatch/);
      assert.match(logs, /Skipping ALL agent loads/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to load agents when an ADK sidecar is missing (cannot verify)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-int-'));
    try {
      fs.mkdirSync(path.join(tmp, 'ccpatch-adk'));
      fs.mkdirSync(path.join(tmp, 'ccpatch-agents'));
      // Runtime file present but NO sidecar → cannot verify → refuse.
      fs.writeFileSync(path.join(tmp, 'ccpatch-adk', 'index.mjs'), 'export const a=1;\n', 'utf8');

      const marker = path.join(tmp, 'LOADED');
      const stub = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes');\n`;
      writeWithSidecar(path.join(tmp, 'ccpatch-agents', 'a.mjs'), stub);

      const logs = runBlock(tmp);
      assert.equal(fs.existsSync(marker), false, 'agent loaded with unverifiable ADK runtime');
      assert.match(logs, /ADK runtime sidecar not found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

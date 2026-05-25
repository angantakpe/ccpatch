/**
 * patch-verification.test.mjs
 *
 * Three-layer test suite for all claude-code patches.
 *
 * Layer 1 — apply():  patch.apply(fixture) !== fixture  (anchor matched, code changed)
 * Layer 2 — verify:   patch.verify.present string exists in the output
 * Layer 3 — runtime:  eval the injected IIFE in a vm sandbox and assert globals
 *
 * Fixtures are minimal synthetic code fragments that contain the anchors each
 * patch targets. We use the real `.cjs` if present; otherwise fall back to a
 * hand-written snippet.  No real API calls are made.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPatchFlags } from '../runner/config.mjs';
import { compileKind } from '../runner/patch-kinds.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// Patches live in two dirs — core/ (bug fixes + infra, mostly required) and
// extensions/ (opt-in features, mostly fragile). Both get the same 3-layer
// treatment so anchor drift in either surfaces as a test failure.
const PATCH_DIRS = [
  { dir: resolve(ROOT, 'core'),       category: 'core' },
  { dir: resolve(ROOT, 'extensions'), category: 'extension' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function shebang(body = '') {
  return `#!/usr/bin/env node\n${body}`;
}

/** Minimal bundle fragment containing the message-stream anchor used by
 *  loop_dynamic, plan_mode_interview, and similar stream-rewriting patches. */
function streamAnchor() {
  // Matches the anchorRe used by message-stream patches.
  // Variable names must be single-char to match the regex \w+.
  return shebang(`
for await(let u of Z){if(u.message){if(yield u.message,u.message.type==="progress"&&u.message.toolUseID){v=u.message.toolUseID,n++
`);
}

/** Load a patch module by absolute file path. */
async function loadPatchByPath(filePath) {
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(filePath).href);
  return mod.default ?? mod;
}

/** Build a minimal vm sandbox with a fake fetch + common globals. */
function makeSandbox(overrides = {}) {
  const ctx = {
    globalThis: {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => {},
    clearTimeout: () => {},
    process: { env: {}, argv: [], versions: { node: '20.0.0' } },
    crypto: { randomUUID: () => 'test-uuid' },
    ...overrides,
  };
  ctx.globalThis = ctx;
  return ctx;
}

/** Extract the first IIFE block injected after the shebang. */
function extractIIFE(code) {
  const afterShebang = code.replace(/^#!.*\n/, '');
  // Match (function() { ... })(); or (()=>{ ... })();
  const m = afterShebang.match(/^\s*(\(function\(\)\s*\{[\s\S]*?\}\)\(\);)/);
  return m ? m[1] : null;
}

/** Run a code string in a fresh vm context; return the context globals. */
function runInSandbox(code, extra = {}) {
  const sandbox = makeSandbox(extra);
  vm.createContext(sandbox);
  try {
    new vm.Script(code).runInContext(sandbox);
  } catch (e) {
    // Some injected code uses async features or browser-only APIs; that's OK —
    // we only care that the globals were registered before any async call.
    if (!e.message.includes('is not defined') && !e.message.includes('async')) throw e;
  }
  return sandbox;
}

// ── Load all patches once ───────────────────────────────────────────────────

// patchPaths[name] = { path: absolute file, category: 'core'|'extension' }
const patchPaths = {};
for (const { dir, category } of PATCH_DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    const name = f.slice(0, -4);
    // Don't let a duplicate name silently shadow — surface it.
    if (patchPaths[name]) {
      throw new Error(`Duplicate patch name "${name}" in ${dir} and ${patchPaths[name].path}`);
    }
    patchPaths[name] = { path: resolve(dir, f), category };
  }
}
const patchNames = Object.keys(patchPaths).sort();

const patches = {};
for (const name of patchNames) {
  patches[name] = await loadPatchByPath(patchPaths[name].path);
}

// A disabled patch failing Layer 1/2 isn't a regression — it's a known-broken
// or version-specific extension intentionally turned off. Demote those failures
// to diagnostics so the test signal stays focused on enabled patches.
const patchFlags = readPatchFlags(resolve(ROOT, 'ccpatch.yml')) ?? {};
function isEnabled(name) {
  // Default to enabled when the YAML doesn't mention it (matches runner behavior).
  return patchFlags[name] !== false;
}

/**
 * Return the effective apply() for a patch. For `kind`-based (declarative)
 * patches the runner synthesizes apply() at runtime via compileKind(); mirror
 * that here so Layer 1/2 can test them without special-casing.
 */
function resolveApply(patch) {
  if (typeof patch.apply === 'function') return patch.apply;
  if (patch.kind && patch.kind !== 'free') {
    try { return compileKind(patch); } catch { return null; }
  }
  return null;
}

// ── Determine the best input fixture for each patch ─────────────────────────

// Find the newest real Claude Code bundle for fixture-based testing.
// Search order:
//   1. CC_BUNDLE_FIXTURE env override (absolute or repo-relative path)
//   2. <repo>/cli.v*.cjs (legacy location)
//   3. <repo>/storage/archives/claude-code-v*/cli.js (extracted bundles)
//   4. null — fall back to synthetic fixtures (anchor-bearing patches will skip)
function findRealBundle() {
  if (process.env.CC_BUNDLE_FIXTURE) {
    const p = resolve(ROOT, process.env.CC_BUNDLE_FIXTURE);
    if (existsSync(p)) return p;
  }
  const legacy = readdirSync(ROOT)
    .filter(f => /^cli\.v[\d.]+\.cjs$/.test(f))
    .sort()
    .pop();
  if (legacy) return resolve(ROOT, legacy);
  const archivesDir = resolve(ROOT, 'storage/archives');
  if (existsSync(archivesDir)) {
    const versionDirs = readdirSync(archivesDir)
      .filter(d => /^claude-code-v[\d.]+$/.test(d))
      .sort((a, b) => {
        const va = a.match(/[\d.]+/)[0].split('.').map(Number);
        const vb = b.match(/[\d.]+/)[0].split('.').map(Number);
        for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
        return 0;
      });
    for (const vd of versionDirs) {
      // Bundles are typically named cli.v2.1.X.cjs (post-extraction) or cli.js (raw).
      const version = vd.match(/v([\d.]+)$/)?.[1];
      const candidates = [
        version && resolve(archivesDir, vd, `cli.v${version}.cjs`),
        resolve(archivesDir, vd, 'cli.cjs'),
        resolve(archivesDir, vd, 'cli.js'),
      ].filter(Boolean);
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  }
  return null;
}

const realBundlePath = findRealBundle();
const realBundle = realBundlePath ? readFileSync(realBundlePath, 'utf8') : null;
const HAS_REAL_BUNDLE = realBundle !== null;
if (HAS_REAL_BUNDLE) {
  process.stderr.write(`[test] using real bundle fixture: ${realBundlePath}\n`);
} else {
  process.stderr.write(`[test] no real bundle found — anchor-dependent tests will skip.\n`);
  process.stderr.write(`[test]   place a bundle at storage/archives/claude-code-vX.Y.Z/cli.js or set CC_BUNDLE_FIXTURE\n`);
}

/** Pick an appropriate fixture for the patch. */
function fixtureFor(name, _patch) {
  if (realBundle) return realBundle;
  // For stream-anchor patches fall back to the synthetic anchor fragment.
  const src = readFileSync(patchPaths[name].path, 'utf8');
  if (src.includes('for await') || src.includes('toolUseID')) return streamAnchor();
  return shebang('/* stub */');
}

/** Some patches' anchors only exist in the real bundle. When there's no real
 *  bundle, skip rather than fail — synthetic fixtures aren't a substitute. */
function shouldSkipWithoutBundle(name) {
  if (HAS_REAL_BUNDLE) return false;
  // Extensions are uniformly anchor-dependent — assume they need a real bundle.
  if (patchPaths[name].category === 'extension') return true;
  const src = readFileSync(patchPaths[name].path, 'utf8');
  // Heuristic: if the patch references minified bundle identifiers or the
  // CJS-IIFE anchor, it can only mutate a real bundle.
  return src.includes('(function(exports, require, module, __filename, __dirname)')
      || /[a-z]{1,3}\d+[A-Z]/.test(src);  // typical bundle minified names like vC7, lZ7
}

// ── Layer 1: apply() changes the code ───────────────────────────────────────

test('Layer 1 — every patch.apply() mutates its input', async (t) => {
  for (const name of patchNames) {
    await t.test(name, () => {
      const patch = patches[name];
      const applyFn = resolveApply(patch);
      if (!applyFn) {
        t.skip('no apply() exported');
        return;
      }
      if (shouldSkipWithoutBundle(name)) {
        t.skip('requires a real Claude Code bundle (set CC_BUNDLE_FIXTURE or place one in storage/archives/)');
        return;
      }
      const fixture = fixtureFor(name, patch);
      let out;
      try {
        out = applyFn(fixture, {});
      } catch (err) {
        assert.fail(`patch.apply() threw: ${err.message}`);
      }
      assert.strictEqual(typeof out, 'string', 'apply() must return a string');
      if (out === fixture) {
        const msg = `patch "${name}" produced no changes — anchor likely broken for this bundle version`;
        if (isEnabled(name)) {
          assert.fail(msg);
        } else {
          t.diagnostic(`${msg} (disabled in ccpatch.yml — demoted to warning)`);
        }
      }
    });
  }
});

// ── Layer 2: verify.present is in the output ────────────────────────────────

test('Layer 2 — verify.present string exists after apply()', async (t) => {
  const patchesWithVerify = patchNames.filter(n => {
    const p = patches[n];
    return p.verify && (p.verify.present || p.verify.absent || p.verify.count !== undefined);
  });

  if (patchesWithVerify.length === 0) {
    t.skip('no patches have verify blocks');
    return;
  }

  for (const name of patchesWithVerify) {
    await t.test(name, () => {
      const patch = patches[name];
      const applyFn = resolveApply(patch);
      if (!applyFn) {
        t.skip('no apply() — declarative kind: patch is synthesized at runtime');
        return;
      }
      if (shouldSkipWithoutBundle(name)) {
        t.skip('requires a real Claude Code bundle (set CC_BUNDLE_FIXTURE or place one in storage/archives/)');
        return;
      }
      const fixture = fixtureFor(name, patch);
      const out = applyFn(fixture, {});

      const { present, absent, count, label } = patch.verify;
      const presents = Array.isArray(present) ? present : (present ? [present] : []);
      const absents  = Array.isArray(absent)  ? absent  : (absent  ? [absent]  : []);
      const reportFail = (msg) => {
        if (isEnabled(name)) assert.fail(msg);
        else t.diagnostic(`${msg} (disabled in ccpatch.yml — demoted to warning)`);
      };
      for (const p of presents) {
        if (!out.includes(p)) {
          reportFail(`verify.present "${label || p.slice(0, 60)}" not found in output of "${name}"`);
        }
      }
      for (const a of absents) {
        if (out.includes(a)) {
          reportFail(`verify.absent "${a.slice(0, 60)}" unexpectedly present in output of "${name}"`);
        }
      }
      if (count !== undefined && count !== null) {
        const c = typeof count === 'number' ? { present: count } : count;
        const countOf = (needle) => {
          let n = 0, idx = 0;
          while ((idx = out.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
          return n;
        };
        if (typeof c.present === 'number') {
          const total = presents.reduce((n, s) => n + countOf(s), 0);
          if (total !== c.present) {
            reportFail(`verify.count.present mismatch for "${name}": expected ${c.present}, got ${total}`);
          }
        }
        if (typeof c.absent === 'number') {
          const total = absents.reduce((n, s) => n + countOf(s), 0);
          if (total !== c.absent) {
            reportFail(`verify.count.absent mismatch for "${name}": expected ${c.absent}, got ${total}`);
          }
        }
      }
    });
  }
});

// ── Layer 3: runtime eval — IIFE patches actually register their globals ────

test('Layer 3 — IIFE patches register expected globals at runtime', async (t) => {
  // Patches that inject a prepend IIFE and the globals they must set.
  const runtimeChecks = {
    fetch_interceptor: {
      // fetch_interceptor prepends flat code (not a self-contained IIFE) before
      // the bundle's CJS wrapper. Extract only the prepended portion, run it in
      // a sandbox, and assert the public API globals are registered.
      custom(_ignored, out) {
        // Everything before the bundle's CJS IIFE is the prepended interceptor code.
        const iifeStart = out.indexOf('(function(exports, require, module,');
        const prepended = iifeStart > 0 ? out.slice(0, iifeStart) : out;
        const sandbox = runInSandbox(prepended, {
          fetch: async () => ({ ok: true, body: null }),
          AbortController: class { signal = {}; abort() {} },
        });
        for (const g of ['__ccpOnFetch', '__ccpOnFetchBefore', '__ccpOnFetchStream', '__ccpFetchInterceptorInstalled__']) {
          assert.ok(sandbox[g] !== undefined, `fetch_interceptor must set globalThis.${g}`);
        }
      },
    },
  };

  for (const [name, spec] of Object.entries(runtimeChecks)) {
    if (!patches[name]) {
      await t.test(name, () => { t.skip('patch not found'); });
      continue;
    }

    await t.test(name, () => {
      const patch = patches[name];
      if (typeof patch.apply !== 'function') { t.skip('no apply()'); return; }

      const fixture = fixtureFor(name, patch);
      const out = patch.apply(fixture, {});

      // Custom check takes priority.
      if (spec.custom) {
        spec.custom({}, out);
        return;
      }

      const iife = extractIIFE(out.replace(/^#!.*\n/, ''));
      if (!iife) { t.skip('no IIFE block in output'); return; }

      const sandbox = runInSandbox(iife, spec.extra || {});

      for (const g of spec.globals) {
        assert.ok(
          sandbox[g] !== undefined,
          `patch "${name}" must set globalThis.${g} at runtime`
        );
      }
    });
  }
});

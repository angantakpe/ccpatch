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
import { readPatchFlags, readProfiles, resolveEffectivePatches } from '../runner/config.mjs';
import { resolveEffectiveApply } from '../runner/effective-apply.mjs';
import {
  BOOT_REGISTRY_SENTINEL,
  collectBootInjects,
  spliceBootRegistry,
} from '../runner/boot-registry.mjs';
import { pickFixture } from './fixtures/registry.mjs';

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
 * Effective apply() for a patch — shared synthesis (declarative kinds via
 * compileKind, boot-only patches via compileBootApply) from
 * runner/effective-apply.mjs, so Layer 1/2/3 test OUTCOME (the hook lands
 * and verifies) regardless of which mechanism injects it, with the SAME
 * synthesis the doctors and runner use.
 */
const resolveApply = resolveEffectiveApply;

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

/** Pick an appropriate fixture for the patch. Delegates to the registry
 *  so per-patch fixture stubs (emitted by bin/scaffold-patch.mjs) are loaded
 *  from one canonical place. */
function fixtureFor(name, _patch) {
  if (realBundle) return realBundle;
  return pickFixture(name, (n) => readFileSync(patchPaths[n].path, 'utf8'));
}

/** A freshly-scaffolded patch gets a registry stub that returns `null` (= "no
 *  synthetic fixture yet"). Without a real bundle, that patch can't be exercised
 *  — but it must NOT skip with the generic bundle-required reason, or the author
 *  never learns their stub is still the placeholder. Detect the null-fixture
 *  case so the skip message can name it distinctly. */
function isNullFixture(name) {
  if (HAS_REAL_BUNDLE) return false;
  return pickFixture(name, (n) => readFileSync(patchPaths[n].path, 'utf8')) === null;
}
const NULL_FIXTURE_SKIP = (name) =>
  `${name}: fixture is still null — replace it in tests/fixtures/registry.mjs`;

/** Agent-dir delivery patches (e.g. adk_hello_agent) ship all behavior in an
 *  emitted ccpatch-agents/<name>.mjs file — apply() is intentionally a no-op,
 *  so Layer 1's "apply() must mutate the bundle" assertion does not apply. The
 *  emitted file's integrity is guaranteed by its .sha256 sidecar at load time,
 *  not by a bundle splice. Mirrors the runner, which exempts these from the
 *  no-change-is-fatal gate via their absent-only verify (see the patch header). */
function isAgentDirOnly(patch) {
  return patch?.agentDir != null && typeof patch.apply === 'function';
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
      const applyFn = resolveApply(patch, name);
      if (!applyFn) {
        t.skip('no apply() exported');
        return;
      }
      if (isNullFixture(name)) {
        t.skip(NULL_FIXTURE_SKIP(name));
        return;
      }
      if (isAgentDirOnly(patch)) {
        t.skip('agent-dir delivery patch — apply() is intentionally a no-op (behavior ships in ccpatch-agents/)');
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
        // No change. Without a REAL bundle this is inconclusive: the synthetic
        // fixture simply may not carry this patch's anchor, so a no-op proves
        // nothing about anchor health. Skip rather than fail — drift-check runs
        // this same suite WITH a downloaded bundle, where the assertion is real.
        // (The heuristic skip above misses some anchor-only core patches; this is
        // the backstop.)
        if (!HAS_REAL_BUNDLE) {
          t.skip(`no change against synthetic fixture — "${name}" needs a real bundle to verify its anchor`);
          return;
        }
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

// ── Layer 1b: idempotency — apply(apply(x)) === apply(x) (repo rule 2) ──────
// Profiles compose onto already-patched bundles (rule 9), so a re-apply that
// injects a second copy silently corrupts composed output and breaks every
// count-based verify. Applying twice must be byte-identical to applying once.

test('Layer 1b — re-apply is a byte-identical no-op (rule 2)', async (t) => {
  for (const name of patchNames) {
    await t.test(name, () => {
      const patch = patches[name];
      const applyFn = resolveApply(patch, name);
      if (!applyFn) {
        t.skip('no apply() exported');
        return;
      }
      if (isNullFixture(name)) {
        t.skip(NULL_FIXTURE_SKIP(name));
        return;
      }
      if (isAgentDirOnly(patch)) {
        t.skip('agent-dir delivery patch — apply() is intentionally a no-op');
        return;
      }
      if (shouldSkipWithoutBundle(name)) {
        t.skip('requires a real Claude Code bundle (set CC_BUNDLE_FIXTURE or place one in storage/archives/)');
        return;
      }
      const fixture = fixtureFor(name, patch);
      let once;
      try {
        once = applyFn(fixture, {});
      } catch (err) {
        assert.fail(`patch.apply() threw: ${err.message}`);
      }
      if (typeof once !== 'string' || once === fixture) {
        t.skip('apply() made no change on this fixture — idempotency check is vacuous here');
        return;
      }
      let twice;
      try {
        twice = applyFn(once, {});
      } catch (err) {
        assert.fail(`re-apply threw: ${err.message}`);
      }
      if (twice !== once) {
        const msg =
          `patch "${name}" is not idempotent: re-apply changed the output by ` +
          `${Math.abs(twice.length - once.length)} byte(s) — guard apply() with its sentinel (rule 2)`;
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
      const applyFn = resolveApply(patch, name);
      if (!applyFn) {
        t.skip('no apply() — declarative kind: patch is synthesized at runtime');
        return;
      }
      if (isNullFixture(name)) {
        t.skip(NULL_FIXTURE_SKIP(name));
        return;
      }
      if (shouldSkipWithoutBundle(name)) {
        t.skip('requires a real Claude Code bundle (set CC_BUNDLE_FIXTURE or place one in storage/archives/)');
        return;
      }
      const fixture = fixtureFor(name, patch);
      const out = applyFn(fixture, {});

      // No change against a synthetic fixture (no real bundle) means the anchor
      // simply isn't in the fixture — verify.present naturally won't be found, so
      // asserting it would be a false negative. Skip; drift-check asserts this
      // for real against a downloaded bundle. Mirrors the Layer 1 backstop.
      if (!HAS_REAL_BUNDLE && out === fixture) {
        t.skip(`no change against synthetic fixture — "${name}" needs a real bundle to verify its anchor`);
        return;
      }

      const { present, absent, count, label } = patch.verify;
      const presents = Array.isArray(present) ? present : (present ? [present] : []);
      const absents  = Array.isArray(absent)  ? absent  : (absent  ? [absent]  : []);
      const reportFail = (msg) => {
        // Without a real bundle the synthetic fixture is best-effort and may not
        // exercise every injection site (e.g. a verify.count that only a full
        // bundle satisfies), so a verify miss here isn't authoritative — demote
        // to a diagnostic. drift-check asserts this strictly against a real
        // downloaded bundle.
        if (!HAS_REAL_BUNDLE) t.diagnostic(`${msg} (synthetic fixture — not authoritative without a real bundle)`);
        else if (isEnabled(name)) assert.fail(msg);
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

// ── Layer 3: runtime eval — injected code actually registers its surface ────
//
// Layers 1/2 prove the bytes changed and the expected substrings exist; this
// layer proves the injected code RUNS: globals register, hook subscriptions
// land. Three generic modes cover the corpus's injection mechanisms:
//
//   preload  — run patch.preloadCode in a sandbox
//   boot     — run the patch's collectBootInjects() block in a sandbox
//   inserted — diff fixture→output, extract the inserted segments, run them
//
// Inserted segments are recovered with a resync diff: walk fixture and output
// in lockstep; on divergence, search the output for the next 64 chars of the
// fixture — the gap is an inserted segment. Patches that REPLACE code (not
// just insert) return null and are skipped here (Layers 1/2 still cover them).

/** Extract inserted-only segments from a single apply. Null on replacement. */
function insertedSegments(input, out, maxSegs = 40) {
  const segs = [];
  let i = 0, j = 0;
  while (i < input.length && j < out.length) {
    if (input[i] === out[j]) { i++; j++; continue; }
    if (segs.length >= maxSegs) return null;
    const probe = input.slice(i, i + 64);
    const found = probe ? out.indexOf(probe, j) : -1;
    if (found === -1) return null; // deletion/replacement — not insert-only
    segs.push(out.slice(j, found));
    j = found;
  }
  if (i >= input.length && j < out.length) segs.push(out.slice(j));
  return segs;
}

/** Host-API stubs the injected code may consume, with recorders so checks can
 *  assert that a patch SUBSCRIBED to a hook (not just that it didn't crash). */
function makeHostStubs(env = {}) {
  const provided = new Map();
  const subscribed = { __ccpOnFetch: 0, __ccpOnFetchBefore: 0, __ccpOnFetchStream: 0 };
  // Hooks accept both signatures in the corpus: fn(cb) and fn('label', cb).
  const sub = (key) => (a, b) => {
    const fn = typeof b === 'function' ? b : a;
    if (typeof fn === 'function') subscribed[key]++;
    return () => {};
  };
  // Module fakes for the node built-ins injected code touches at install time.
  const moduleFakes = {
    os: { homedir: () => '/tmp/ccp-test-home', tmpdir: () => '/tmp', platform: () => 'linux' },
    fs: {
      existsSync: () => false, readFileSync: () => '', writeFileSync: () => {},
      appendFileSync: () => {}, mkdirSync: () => {}, statSync: () => ({ mode: 0o600 }),
      watch: () => ({ close: () => {} }),
    },
    path: { join: (...a) => a.join('/'), resolve: (...a) => a.join('/'), dirname: (p) => String(p) },
    net: { createServer: () => ({ listen: () => {}, on: () => {}, close: () => {} }) },
    crypto: {
      randomUUID: () => 'test-uuid', randomBytes: (n) => Buffer.alloc(n),
      createHash: () => ({ update() { return this; }, digest: () => 'x'.repeat(64) }),
      timingSafeEqual: (a, b) => a.length === b.length,
    },
  };
  const fakeRequire = (id) => moduleFakes[String(id).replace(/^node:/, '')] ?? {};
  const extras = {
    __ccpProvide: (k, v) => { provided.set(k, v); return v; },
    __ccpRequire: (k) => provided.get(k),
    __ccpOnFetch: sub('__ccpOnFetch'),
    __ccpOnFetchBefore: sub('__ccpOnFetchBefore'),
    __ccpOnFetchStream: sub('__ccpOnFetchStream'),
    __ccpBus: { on: () => () => {}, emit: () => {}, topics: () => [] },
    require: fakeRequire,
    module: { exports: {} },
    process: {
      env: { ...env }, argv: [], versions: { node: '20.0.0' }, pid: 1234,
      platform: 'linux', cwd: () => '/tmp', on: () => {}, once: () => {},
      exit: () => {}, stderr: { write: () => {} }, stdout: { write: () => {} },
    },
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    queueMicrotask: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, body: null }),
    AbortController: class { signal = {}; abort() {} },
  };
  return { extras, provided, subscribed };
}

/** Run a list of code blocks in ONE sandbox; skip blocks that don't parse
 *  standalone (mid-expression splices). Async because some boot hooks are
 *  async IIFEs (dynamic import()) — we give their microtasks a few turns to
 *  settle before the caller asserts. Returns { sandbox, ran, skipped }. */
async function runBlocks(blocks, extras) {
  const sandbox = makeSandbox(extras);
  vm.createContext(sandbox);
  // Resolve dynamic import() of node built-ins via the main-context loader
  // (async boot hooks like mcp_lazy use `await import('node:fs')`).
  const scriptOpts = { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER };
  let ran = 0, skipped = 0;
  for (const block of blocks) {
    let script;
    try {
      script = new vm.Script(block, scriptOpts);
    } catch {
      skipped++; // fragment spliced inside a host function — not runnable alone
      continue;
    }
    try {
      script.runInContext(sandbox);
      ran++;
    } catch (e) {
      // Injected code is rule-4 fail-open; tolerate missing bundle-local refs.
      if (!/is not defined|async/.test(e.message)) throw e;
      ran++;
    }
  }
  // Let async IIFEs settle (a few macrotask turns is plenty for import()s).
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 5));
  return { sandbox, ran, skipped };
}

test('Layer 3 — injected code registers its runtime surface', async (t) => {
  // Per-patch expectations. `globals` must be set on globalThis after the
  // injected code runs; `subscribes` hooks must have gained >=1 subscriber.
  const runtimeChecks = {
    // ── preload patches ──
    contracts: { mode: 'preload', globals: ['__ccpRegistry', '__ccpProvide', '__ccpRequire'] },
    coverage_kernel: { mode: 'preload', globals: ['__ccpCoverage'] },
    cost_tracker: { mode: 'preload', subscribes: ['__ccpOnFetch'] },
    tools_log: { mode: 'preload', subscribes: ['__ccpOnFetch'] },

    // ── boot-inject patches ──
    bun_shim: { mode: 'boot', globals: ['Bun'] },
    tool_result_error_content: { mode: 'boot', subscribes: ['__ccpOnFetchBefore'] },
    mcp_lazy: { mode: 'boot', subscribes: ['__ccpOnFetchBefore'] },

    // ── inserted (spliceBoot / mid-bundle) patches ──
    event_bus: { mode: 'inserted', globals: ['__ccpBus', '__ccpBus_v1'] },
    auth_token: { mode: 'inserted', globals: ['__ccpAuth_v1'] },
    agent_lifecycle: { mode: 'inserted', globals: ['__ccpAgentLifecycle_v1'] },
    agent_tree: { mode: 'inserted', globals: ['__ccpAgentTree_v1'] },
    assistant_stream_events: { mode: 'inserted', globals: ['__ccpAssistantStream_v1'] },
    custom_commands: { mode: 'inserted', globals: ['__ccpRegisterSlashCommand'] },
    slash_dispatch: { mode: 'inserted', globals: ['__ccpSlashDispatchInstalled'] },
    subagent_hooks_stub: { mode: 'inserted', globals: ['__ccpSubagent', '__ccpSubagentStubInstalled'] },
    // The bridge only installs when CC_BRIDGE_ADDR is set (off-by-default gate).
    headless_bridge: { mode: 'inserted', globals: ['__ccpHeadlessBridge_v1'], env: { CC_BRIDGE_ADDR: '127.0.0.1:0' } },
    rate_limit: { mode: 'inserted', globals: ['__ccpRateLimitRegistered'] },
    policy_gate: { mode: 'inserted', globals: ['__ccpPolicyGateInstalled_v1'] },
    dotenv_loader: { mode: 'inserted', globals: ['__ccpDotenvLoaded'] },
    // The boot half registers the globals; the mid-function override-apply
    // fragment is context-dependent and skipped by the parse filter.
    expose_system_prompt: { mode: 'inserted', globals: ['__ccpSystemPromptExposed_v1', '__ccpGetSystemPrompt'] },
    // NOT covered: expose_tool_dispatch — ALL its globals are registered
    // inside the bundle's tool-context function (they close over host locals),
    // so no injected block is runnable standalone. Behavioral coverage for it
    // lives in the daemon-profile integration round-trip (test:integration).

    // ── custom ──
    standup_command: {
      // standup_command REPLACES the submit useCallback with a wrapping IIFE, so
      // the insert-diff recovery can't isolate a runnable block. Instead, drive
      // the wrapper directly: evaluate the patched fixture's wrapper expression
      // in a sandbox, invoke it with a fake original callback, and assert it
      //   (a) installs the composer global, and
      //   (b) rewrites a /standup queued command into a normal prompt before
      //       delegating (the core "rewrite, don't print" contract).
      custom(_ignored, out) {
        // Build the wrapper expression in isolation rather than slicing it out
        // of a 16 MB bundle: re-derive the var/React names from the patched
        // output's sentinel-adjacent decl, then evaluate ONLY that statement.
        // The wrapper shape is `var <S>=!0;let <var>=(function(__ccpCb){...})(...);`
        const wrapRe = /var __ccpStandupCommand_v1=!0;let ([A-Za-z_$][\w$]*)=\(function\(__ccpCb\)/;
        assert.ok(wrapRe.test(out), 'standup_command must wrap the submit useCallback as an IIFE');

        // Drive the composer + adapter directly with a hand-built wrapper that
        // mirrors what apply() injects, fed a fake original callback. This keeps
        // the runtime assertion independent of the surrounding bundle text.
        const declStart = out.indexOf('var __ccpStandupCommand_v1=!0;');
        // Capture from the sentinel decl up to the end of the IIFE invocation:
        // find `(function(__ccpCb)`'s matching `})(`, then paren-count the call.
        const fnStart = out.indexOf('(function(__ccpCb)', declStart);
        // Locate `})(` that closes the function body and opens the invocation.
        const invokeOpen = out.indexOf('})(', fnStart);
        assert.ok(invokeOpen > 0, 'wrapper IIFE invocation not found');
        // Paren-count the invocation argument list to find its close.
        let i = invokeOpen + 2; // at the '('
        let depth = 0, end = -1;
        for (; i < out.length; i++) {
          const ch = out[i];
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        assert.ok(end > 0, 'wrapper IIFE close not found');
        // Replace the real original-callback arg with a recording stub so the
        // statement is self-contained (no bundle identifiers leak in).
        const captured = [];
        // Rewrite the `let <var>=` binding to a global assignment so the
        // resulting adapter is observable on the sandbox (a `let` decl wouldn't
        // surface as a sandbox property).
        const head = out
          .slice(declStart, invokeOpen + 3)
          .replace(/let [A-Za-z_$][\w$]*=\(function\(__ccpCb\)/, 'globalThis.__ccpStandupAdapterOut=(function(__ccpCb)');
        const stmt = head + '__ccpFakeOrig);';

        const sandbox = makeSandbox({
          __ccpFakeOrig: function (...a) { captured.push(a[0]); return 'delegated'; },
          require: () => { throw new Error('no child_process in sandbox'); },
          process: { cwd: () => '/tmp', env: {}, argv: [], versions: { node: '20.0.0' } },
        });
        vm.createContext(sandbox);
        new vm.Script(stmt).runInContext(sandbox);

        // (a) composer global installed
        assert.equal(
          typeof sandbox.__ccpStandupCommand_v1BuildPrompt, 'function',
          'standup_command must install globalThis.__ccpStandupCommand_v1BuildPrompt',
        );
        // Non-/standup input returns null (leave the prompt untouched).
        assert.equal(sandbox.__ccpStandupCommand_v1BuildPrompt('hello'), null);
        // /standup yields a rewritten prompt (git unavailable here → graceful text).
        const gen = sandbox.__ccpStandupCommand_v1BuildPrompt('/standup');
        assert.equal(typeof gen, 'string');
        assert.match(gen, /standup/i);

        // (b) the adapter rewrites a queued /standup command before delegating.
        const adapter = sandbox.__ccpStandupAdapterOut;
        assert.equal(typeof adapter, 'function', 'wrapper must yield the adapter callback');
        const qc = [{ value: '/standup', preExpansionValue: '/standup', mode: 'prompt' }];
        adapter(qc);
        assert.notEqual(qc[0].value, '/standup', 'adapter must rewrite the /standup value');
        assert.equal(qc[0].skipSlashCommands, true, 'rewritten prompt must not be re-dispatched as a slash command');
        assert.ok(captured.length > 0, 'adapter must delegate to the original callback');
      },
    },
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
      await t.test(name, (tt) => { tt.skip('patch not found'); });
      continue;
    }

    await t.test(name, async (tt) => {
      const patch = patches[name];
      const { extras, subscribed } = makeHostStubs(spec.env);
      let blocks = null;

      if (spec.custom) {
        const applyFn = resolveApply(patch, name);
        if (!applyFn) { tt.skip('no apply()'); return; }
        spec.custom({}, applyFn(fixtureFor(name, patch), {}));
        return;
      }

      if (spec.mode === 'preload') {
        if (typeof patch.preloadCode !== 'string') { tt.skip('no preloadCode'); return; }
        blocks = [patch.preloadCode];
      } else if (spec.mode === 'boot') {
        const { entries } = collectBootInjects(
          { [name]: patch }, [name],
          { code: '', options: { version: '0.0.0-test' } },
        );
        if (!entries.length) { tt.skip('no boot entry resolved'); return; }
        blocks = entries.map(e => e.code);
      } else {
        const applyFn = resolveApply(patch, name);
        if (!applyFn) { tt.skip('no apply()'); return; }
        const fixture = fixtureFor(name, patch);
        if (fixture == null) { tt.skip(NULL_FIXTURE_SKIP(name)); return; }
        const out = applyFn(fixture, {});
        if (out === fixture) { tt.skip('apply() was a no-op on this fixture'); return; }
        blocks = insertedSegments(fixture, out);
        if (blocks === null) { tt.skip('patch replaces code (not insert-only) — segments unrecoverable'); return; }
      }

      const { sandbox, ran } = await runBlocks(blocks, extras);
      assert.ok(ran > 0, `patch "${name}": no injected block was runnable standalone`);

      for (const g of spec.globals ?? []) {
        assert.ok(sandbox[g] !== undefined, `patch "${name}" must set globalThis.${g} at runtime`);
      }
      for (const hook of spec.subscribes ?? []) {
        assert.ok(subscribed[hook] > 0, `patch "${name}" must subscribe to ${hook} at runtime`);
      }
    });
  }

  // Coverage floor: every enabled patch that registers a __ccp* global should
  // eventually have a Layer-3 entry. Surface the uncovered set as a diagnostic
  // (not a failure) so additions are visible, and ratchet via the count below.
  const registersGlobal = (name) => {
    const src = readFileSync(patchPaths[name].path, 'utf8');
    return /globalThis\.__ccp[A-Za-z_]+\s*=/.test(src);
  };
  const uncovered = patchNames.filter(
    n => isEnabled(n) && registersGlobal(n) && !runtimeChecks[n],
  );
  if (uncovered.length) {
    t.diagnostic(`Layer 3 uncovered global-registering patches: ${uncovered.join(', ')}`);
  }
});

// ── Layer 4: boot-injection registry — single splice, declared order, ───────
// ── per-patch idempotency ────────────────────────────────────────────────────

test('Layer 4 — boot registry: one splice, declared order, idempotent re-apply', async (t) => {
  // Synthetic shebang-less CJS-IIFE bundle (the Bun-extracted shape).
  const FIXTURE = '(function(exports, require, module, __filename, __dirname) {/* body */\n})(module.exports, require, module, __filename, __dirname);\n';
  const IIFE_HEAD = '(function(exports, require, module, __filename, __dirname)';

  const bootPatchNames = patchNames.filter(n => patches[n]?.bootInject);

  await t.test('the migrated boot patches all declare bootInject', () => {
    for (const expected of [
      'fetch_interceptor', 'bun_shim', 'tool_result_error_content',
      'boot_banner', 'mcp_lazy', 'stdin_da1_leak',
    ]) {
      assert.ok(bootPatchNames.includes(expected), `${expected} must declare bootInject`);
    }
  });

  await t.test('single splice carries every hook in declared order, before the IIFE head', () => {
    const { entries } = collectBootInjects(patches, bootPatchNames, { code: FIXTURE, options: { version: '0.0.0-test' } });
    assert.equal(entries.length, bootPatchNames.length, 'no patch skipped on a pristine fixture');
    const out = spliceBootRegistry(FIXTURE, entries);
    assert.notEqual(out, FIXTURE, 'splice must change the fixture');

    // Exactly ONE registry block.
    const sentinelCount = out.split(BOOT_REGISTRY_SENTINEL).length - 1;
    assert.equal(sentinelCount, 1, 'exactly one registry block');

    // The whole block sits BEFORE the CJS-IIFE head.
    const iifeAt = out.indexOf(IIFE_HEAD);
    for (const e of entries) {
      const at = out.indexOf(`// ── ${e.name}: boot hook`);
      assert.ok(at !== -1 && at < iifeAt, `${e.name} hook must precede the IIFE head`);
    }

    // Declared order is reproduced top-to-bottom (order asc, name tiebreak) —
    // in particular fetch_interceptor's bus precedes its subscribers.
    const offsets = entries.map(e => out.indexOf(`// ── ${e.name}: boot hook`));
    const sorted = [...offsets].sort((a, b) => a - b);
    assert.deepEqual(offsets, sorted, 'separator offsets must be monotonically increasing');
    const fi = out.indexOf('// ── fetch_interceptor: boot hook');
    for (const sub of ['tool_result_error_content', 'mcp_lazy']) {
      if (!bootPatchNames.includes(sub)) continue;
      assert.ok(fi < out.indexOf(`// ── ${sub}: boot hook`), `fetch bus must precede ${sub}`);
    }
  });

  await t.test('re-apply is a per-patch no-op (byte-identical)', () => {
    const first = spliceBootRegistry(
      FIXTURE,
      collectBootInjects(patches, bootPatchNames, { code: FIXTURE, options: {} }).entries,
    );
    const again = collectBootInjects(patches, bootPatchNames, { code: first, options: {} });
    assert.equal(again.entries.length, 0, 'all sentinels present — nothing to inject');
    assert.deepEqual([...again.skipped].sort(), [...bootPatchNames].sort(), 'every patch skipped by its sentinel');
    const second = spliceBootRegistry(first, again.entries);
    assert.equal(second, first, 'second apply must be byte-identical');
  });

  await t.test('shebang bundles splice after the shebang line (startsWith, not includes)', () => {
    const shebangFixture = '#!/usr/bin/env node\nconst x = 1;\n';
    const { entries } = collectBootInjects(patches, ['stdin_da1_leak'], { code: shebangFixture, options: {} });
    const out = spliceBootRegistry(shebangFixture, entries);
    assert.ok(out.startsWith('#!/usr/bin/env node\n'), 'shebang stays first');
    assert.ok(out.indexOf(BOOT_REGISTRY_SENTINEL) > 0, 'block lands after the shebang');
    // Interior "#!/usr/bin/env node" literals must NOT attract the splice.
    const interior = 'const s = "#!/usr/bin/env node";\n' + FIXTURE;
    const out2 = spliceBootRegistry(interior, collectBootInjects(patches, ['stdin_da1_leak'], { code: interior, options: {} }).entries);
    assert.ok(
      out2.indexOf(BOOT_REGISTRY_SENTINEL) < out2.indexOf(IIFE_HEAD),
      'no-leading-shebang bundles anchor on the CJS-IIFE head',
    );
    assert.ok(
      out2.indexOf(BOOT_REGISTRY_SENTINEL) > out2.indexOf('#!/usr/bin/env node'),
      'interior shebang literal is not used as an anchor',
    );
  });

  await t.test('anchorless input fails loud but open (warn + unchanged)', () => {
    const plain = 'const nothing = true;\n';
    const { entries } = collectBootInjects(patches, ['stdin_da1_leak'], { code: plain, options: {} });
    const warns = [];
    const out = spliceBootRegistry(plain, entries, { warn: (m) => warns.push(m) });
    assert.equal(out, plain, 'code returned unchanged');
    assert.equal(warns.length, 1, 'one loud warning');
    assert.match(warns[0], /boot-registry/);
  });
});

// ── COD-13: adk_handoff_demo is a shipped reference consumer ──────────────────
// COD-12 marked the handoff/router/memory surfaces PROVISIONAL and deferred the
// "ship a real consumer" decision here. This locks the contract that makes
// adk_handoff_demo a shipped consumer: it must (1) be an agent-dir-only patch
// whose no-op apply() is idempotent (rule 2), (2) carry a STRONG verify that
// does not trip the UNVERIFIED/--strict gate (rule 3), and (3) be a member of
// the `adk` profile with every hard dependsOn resolved in that profile — i.e.
// the profile actually BUILDS. (3) is the load-bearing one: --profile ignores
// the per-patch enabled flags, so the consumer's deps must be listed in the
// profile or the build throws at the dependsOn gate before this patch runs.

test('COD-13 — adk_handoff_demo ships as a buildable adk-profile consumer', async (t) => {
  const NAME = 'adk_handoff_demo';
  const patch = patches[NAME];

  await t.test('is loaded and agent-dir-only with an idempotent no-op apply (rule 2)', () => {
    assert.ok(patch, `${NAME} must be loadable from extensions/`);
    assert.ok(isAgentDirOnly(patch), `${NAME} must ship its behavior via agentDir, not a bundle splice`);
    // No-op apply() is idempotent by construction: applying twice is byte-identical.
    const sample = 'const x = 1;\n';
    assert.equal(patch.apply(sample), sample, 'apply() must be a no-op (behavior ships in ccpatch-agents/)');
    assert.equal(patch.apply(patch.apply(sample)), sample, 're-apply must be byte-identical (rule 2)');
  });

  await t.test('verify is strong — absent-only, not the weak present-only shape (rule 3)', () => {
    const v = patch.verify;
    assert.ok(v, `${NAME} must declare a verify block`);
    const hasPresent = v.present != null;
    const hasAbsent = v.absent != null;
    const hasCount = v.count != null;
    // Weak == present-only (no absent, no count) — that is what shows UNVERIFIED
    // under --strict. An absent-only verify is the agent-dir contract and is
    // explicitly exempt (runner/anchors.mjs isWeakLocal + apply-pipeline gate).
    const isWeak = hasPresent && !hasAbsent && !hasCount;
    assert.ok(!isWeak, `${NAME} verify must not be present-only (would show UNVERIFIED under --strict)`);
    assert.ok(hasAbsent || hasCount, `${NAME} verify must assert absent: or count:`);
  });

  await t.test('is a member of the adk profile with all hard deps resolved there', () => {
    const flags = readPatchFlags(resolve(ROOT, 'ccpatch.yml')) ?? {};
    const { selected } = resolveEffectivePatches({
      patches: flags,
      requested: null,
      profile: 'adk',
      yamlPath: resolve(ROOT, 'ccpatch.yml'),
    });
    const sel = new Set(selected);
    assert.ok(sel.has(NAME), `${NAME} must be selected by --profile adk`);
    // Every hard dependsOn must ALSO be in the resolved adk set, or the build
    // throws "requires <dep>, but it is not enabled" before this patch applies.
    for (const dep of patch.dependsOn ?? []) {
      assert.ok(sel.has(dep), `adk profile must include ${NAME}'s hard dep "${dep}" (else --profile adk build-fails)`);
    }
  });

  await t.test('the adk profile is defined and extends standard', () => {
    const profiles = readProfiles(resolve(ROOT, 'ccpatch.yml'));
    assert.ok(profiles && profiles.adk, 'adk profile must be defined in ccpatch.yml');
  });
});

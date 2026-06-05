/**
 * adk-types.test.mjs — .d.ts drift guard for the ccpatch ADK (FINDING 14).
 *
 * The public TypeScript surface (packages/adk/index.d.ts) is HAND-AUTHORED to
 * mirror the JSDoc-typed .mjs runtime. Nothing else forces the two to agree, so
 * this test pins them together two ways:
 *
 *   1. STRUCTURAL cross-check (dependency-free, always runs): parse the declared
 *      value exports out of index.d.ts (`export function|class|const`) and assert
 *      each exists at runtime; and assert a curated set of KEY runtime exports is
 *      declared in the .d.ts. A new runtime export that someone forgot to declare
 *      (or a declared one that was renamed/removed at runtime) fails here.
 *
 *   2. TYPE-LEVEL fixture (best-effort): compile tests/fixtures/adk-types-usage.ts
 *      with the repo's own `tsc` under --strict. The fixture exercises
 *      defineTool/defineHandoff/createAdk/createMemory/capabilities + the
 *      introspection additions, so a signature drift in the .d.ts fails to
 *      compile. Skipped (not failed) only if a tsc binary cannot be located.
 *
 * Pure ESM, runnable under `node --test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import * as runtime from '../packages/adk/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DTS_PATH = resolve(ROOT, 'packages/adk/index.d.ts');

/**
 * Parse the names of VALUE exports declared in a .d.ts (functions/classes/const).
 * Deliberately ignores `export interface|type` (those are type-only and have no
 * runtime counterpart).
 * @param {string} src
 * @returns {Set<string>}
 */
function declaredValueExports(src) {
  const names = new Set();
  const re = /^export\s+(?:declare\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

const dtsSrc = readFileSync(DTS_PATH, 'utf8');
const declared = declaredValueExports(dtsSrc);

// Runtime value exports (drop the synthetic ESM namespace marker).
const runtimeExports = new Set(Object.keys(runtime).filter((k) => k !== 'default'));

test('every value export declared in index.d.ts exists at runtime', () => {
  assert.ok(declared.size > 0, 'parsed at least one declared value export');
  const missing = [...declared].filter((name) => !(name in runtime));
  assert.deepEqual(missing, [], `declared in .d.ts but absent at runtime: ${missing.join(', ')}`);
});

test('key runtime exports are declared in index.d.ts (no silent drift)', () => {
  // Curated load-bearing surface — every one of these MUST be declared.
  const keyExports = [
    'defineAgent', 'getAgent', 'listAgents',
    'defineTool', 'listTools',
    'defineHandoff', 'restoreSystemPrompt', 'swapDepth', 'currentPersona',
    'AgentRouter',
    'createMemory',
    'capabilities', 'useAgentBus',
    'createAdk',
  ];
  for (const name of keyExports) {
    assert.ok(runtimeExports.has(name), `expected runtime export "${name}" to exist`);
    assert.ok(declared.has(name), `runtime export "${name}" is NOT declared in index.d.ts`);
  }
});

test('introspection + handshake additions are declared in index.d.ts', () => {
  // These are the FINDING 12/13/2 additions — pin them explicitly so a future
  // edit cannot drop the declaration while keeping the runtime export.
  for (const name of ['listTools', 'swapDepth', 'currentPersona']) {
    assert.ok(declared.has(name), `${name} must stay declared`);
  }
  // The capabilities() detail surface is type-only; assert its interfaces exist.
  assert.match(dtsSrc, /interface\s+Capabilities\b/);
  assert.match(dtsSrc, /interface\s+CapabilityDetail\b/);
  assert.match(dtsSrc, /detail:\s*CapabilityDetailMap/);
});

// ── Type-level fixture compile (best-effort) ──────────────────────────────────

/** Locate a runnable tsc binary, or null if none is available. */
function findTsc() {
  const candidates = [
    resolve(ROOT, 'node_modules/.bin/tsc'),
    resolve(ROOT, 'node_modules/typescript/bin/tsc'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

test('TS fixture compiles clean against index.d.ts (signature drift guard)', (t) => {
  const tsc = findTsc();
  if (!tsc) {
    t.skip('no tsc binary found — structural cross-check still covers drift');
    return;
  }
  const tsconfig = resolve(ROOT, 'tests/fixtures/tsconfig.adk-types.json');
  // tsc binaries under node_modules/.bin are Node scripts; invoke via node for
  // portability across platforms (the .bin shim may not be +x in all checkouts).
  const isJs = tsc.endsWith('.js') || tsc.includes('/typescript/bin/');
  const res = isJs
    ? spawnSync(process.execPath, [tsc, '--noEmit', '-p', tsconfig], { cwd: ROOT, encoding: 'utf8' })
    : spawnSync(tsc, ['--noEmit', '-p', tsconfig], { cwd: ROOT, encoding: 'utf8' });

  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  assert.equal(res.status, 0, `tsc reported type errors against the ADK .d.ts:\n${out}`);
});

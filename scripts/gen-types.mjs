#!/usr/bin/env node
/**
 * gen-types.mjs — keep types/patch.d.ts in sync with runner/manifest.mjs.
 *
 * The hand-written types/patch.d.ts is the editor-facing surface. This script
 * is the drift detector: it extracts the enum lists the validator actually
 * enforces (CAPABILITIES, KINDS, AT_KINDS, PHASES, CATEGORIES, APPLY_MODES)
 * and compares them with the union types declared in patch.d.ts.
 *
 * Usage:
 *   node scripts/gen-types.mjs           # check (default); exits 1 on drift
 *   node scripts/gen-types.mjs --check   # explicit check mode
 *   node scripts/gen-types.mjs --write   # patch type unions in-place (best-effort)
 *
 * Wired into CI via `npm run gen:types` (acts as check).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MANIFEST = resolve(ROOT, 'runner/manifest.mjs');
const TYPES = resolve(ROOT, 'types/patch.d.ts');

const mode = process.argv.includes('--write') ? 'write' : 'check';

/** Extract a JS array literal like `['a','b']` after a `new Set(...)` or `Object.freeze([...])`. */
function extractArray(src, ...patterns) {
  for (const re of patterns) {
    const m = src.match(re);
    if (m) {
      return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    }
  }
  return null;
}

const manifestSrc = readFileSync(MANIFEST, 'utf8');
const atSelSrc = readFileSync(resolve(ROOT, 'runner/at-selector.mjs'), 'utf8');
const kindsSrc = readFileSync(resolve(ROOT, 'runner/patch-kinds.mjs'), 'utf8');

const enums = {
  Capability: extractArray(manifestSrc, /CAPABILITIES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/),
  Phase: extractArray(manifestSrc, /PHASES\s*=\s*new Set\(\[([\s\S]*?)\]\)/),
  Category: extractArray(manifestSrc, /CATEGORIES\s*=\s*new Set\(\[([\s\S]*?)\]\)/),
  ApplyMode: extractArray(manifestSrc, /APPLY_MODES\s*=\s*new Set\(\[([\s\S]*?)\]\)/),
  Kind: extractArray(kindsSrc, /KINDS\s*=\s*\[([\s\S]*?)\]/),
  AtKind: extractArray(atSelSrc, /AT_KINDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/),
};

for (const [k, v] of Object.entries(enums)) {
  if (!v || v.length === 0) {
    console.error(`gen-types: failed to extract ${k} from sources`);
    process.exit(2);
  }
}

let typesSrc = readFileSync(TYPES, 'utf8');
const drift = [];

/** Build the expected `export type Foo = 'a' | 'b';` block. */
function expectedUnion(name, values) {
  const lines = values.map((v, i) => `  ${i === 0 ? '|' : '|'} '${v}'`).join('\n');
  return `export type ${name} =\n${lines};`;
}

/** Check (and optionally rewrite) one union in types/patch.d.ts. */
function syncUnion(name, values) {
  // Match an `export type Name = ...;` block (single- or multi-line).
  const re = new RegExp(`export type ${name} =\\s*([\\s\\S]*?);`, 'm');
  const m = typesSrc.match(re);
  if (!m) {
    drift.push(`types/patch.d.ts: missing \`export type ${name}\``);
    return;
  }
  const found = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  const expected = values;
  const same = found.length === expected.length
    && found.every((x, i) => x === expected[i]);
  if (!same) {
    drift.push(
      `types/patch.d.ts: ${name} drifted — types=${JSON.stringify(found)} ` +
      `manifest=${JSON.stringify(expected)}`
    );
    if (mode === 'write') {
      typesSrc = typesSrc.replace(re, expectedUnion(name, expected));
    }
  }
}

for (const [name, values] of Object.entries(enums)) {
  syncUnion(name, values);
}

if (mode === 'write' && drift.length > 0) {
  writeFileSync(TYPES, typesSrc);
  console.log(`gen-types: rewrote ${drift.length} union(s) in types/patch.d.ts`);
  for (const d of drift) console.log(`  - ${d}`);
  process.exit(0);
}

if (drift.length > 0) {
  console.error('gen-types: types/patch.d.ts is out of sync with runner/manifest.mjs:');
  for (const d of drift) console.error(`  ${d}`);
  console.error('\nFix: run `npm run gen:types -- --write`, review the diff, commit.');
  process.exit(1);
}

console.log('gen-types: types/patch.d.ts is in sync with the validator.');

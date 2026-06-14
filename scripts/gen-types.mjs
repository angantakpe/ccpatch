#!/usr/bin/env node
/**
 * gen-types.mjs — generate types/patch.d.ts from the ONE declarative schema.
 *
 * SOURCE OF TRUTH: runner/manifest-schema.mjs. This script walks that schema
 * (enums + sub-shapes + Patch fields + NormalizedPatch fields) and EMITS the
 * entire types/patch.d.ts. The validator (runner/manifest.mjs) consumes the
 * same schema's enum sets at runtime, so the .d.ts and the validator can no
 * longer drift — there is a single source.
 *
 * Cross-check: AT_KINDS (runner/at-selector.mjs) and KINDS (runner/patch-kinds.mjs)
 * are independent runtime exports used by the selector/kind machinery. We assert
 * the schema's AtKind/Kind enums equal those exports so the schema cannot drift
 * from the actual selector vocabulary.
 *
 * Usage:
 *   node scripts/gen-types.mjs            # check (default); exits 1 on drift
 *   node scripts/gen-types.mjs --check    # explicit check mode
 *   node scripts/gen-types.mjs --write    # (re)write types/patch.d.ts
 *
 * Wired into CI via `npm run gen:types` (acts as check) and `npm run lint:types`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENUMS,
  TYPE_ALIASES,
  INTERFACES,
  PATCH_FIELDS,
  PATCH_SHAPE_BLOCK,
  NORMALIZED_FIELDS,
  enumValues,
  KINDS_LIST,
  AT_KINDS_LIST,
} from '../runner/manifest-schema.mjs';
import { AT_KINDS } from '../runner/at-selector.mjs';
import { KINDS } from '../runner/patch-kinds.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TYPES = resolve(ROOT, 'types/patch.d.ts');

const mode = process.argv.includes('--write') ? 'write' : 'check';

// ── Cross-check: schema enums must match the runtime selector/kind exports ───
function assertSame(label, a, b) {
  const eq = a.length === b.length && a.every((x, i) => x === b[i]);
  if (!eq) {
    console.error(
      `gen-types: schema ${label} drifted from runtime export — ` +
      `schema=${JSON.stringify(a)} runtime=${JSON.stringify(b)}`
    );
    process.exit(2);
  }
}
assertSame('AtKind', AT_KINDS_LIST, [...AT_KINDS]);
assertSame('Kind', KINDS_LIST, [...KINDS]);

// ── Emitters ─────────────────────────────────────────────────────────────────
const docComment = (doc, indent = '') =>
  doc ? `${indent}/** ${doc} */\n` : '';

function emitEnum(name, entries) {
  // One value per line. Per-value docs become a leading block comment so the
  // union's terminating `;` is never swallowed by a trailing inline comment.
  const hasDocs = entries.some((e) => e.doc);
  let head = '';
  if (hasDocs) {
    head = '/**\n' +
      entries.map((e) => ` * - ${e.value}${e.doc ? `: ${e.doc}` : ''}`).join('\n') +
      '\n */\n';
  }
  const body = enumValues(entries).map((v) => `  | '${v}'`).join('\n');
  return `${head}export type ${name} =\n${body};`;
}

function emitAlias(a) {
  let s = docComment(a.doc);
  // Multi-line union bodies start with a newline; single-expression bodies are inline.
  if (a.body.includes('\n')) {
    s += `export type ${a.name} =\n${a.body};`;
  } else {
    s += `export type ${a.name} = ${a.body};`;
  }
  return s;
}

function emitField(f) {
  return `${docComment(f.doc, '  ')}  ${f.name}: ${f.type};`;
}

function emitInterface(iface) {
  let s = docComment(iface.doc);
  s += `export interface ${iface.name} {\n`;
  s += iface.fields.map(emitField).join('\n');
  s += `\n}`;
  return s;
}

function emitSectionedFields(fields) {
  const lines = [];
  for (const f of fields) {
    if (f.section) {
      lines.push(`\n  // ── ${f.section} ──`);
    }
    if (f.doc) lines.push(`  /** ${f.doc} */`);
    lines.push(`  ${f.name}: ${f.type};`);
  }
  return lines.join('\n');
}

function generate() {
  const parts = [];

  parts.push(`/**
 * Patch type definitions for ccpatch.
 *
 * GENERATED FILE — do not edit by hand.
 * SOURCE OF TRUTH: runner/manifest-schema.mjs
 * Regenerate with: npm run gen:types -- --write
 *
 * The same schema drives validateManifest() in runner/manifest.mjs at runtime,
 * so this surface and the validator cannot drift. CI guard: \`npm run gen:types\`
 * (and \`npm run lint:types\`) re-runs this generator in --check mode.
 *
 * Usage in a patch file:
 *   /** @type {import('../types/patch').Patch} *\\/
 *   export default {
 *     description: '…',
 *     verify: { present: '…' },
 *     apply(code) { return code; },
 *   };
 */`);

  // Enums
  parts.push(`// ── Enums (generated from runner/manifest-schema.mjs) ──`);
  for (const [name, entries] of Object.entries(ENUMS)) {
    parts.push(emitEnum(name, entries));
  }

  // Sub-shapes: interfaces + the FunctionSpec/LifecycleHook aliases.
  parts.push(`// ── Sub-shapes ──`);
  // FunctionSpec alias first (referenced by interfaces).
  const fnSpec = TYPE_ALIASES.find((a) => a.name === 'FunctionSpec');
  if (fnSpec) parts.push(emitAlias(fnSpec));
  for (const iface of INTERFACES) {
    // LifecycleHook alias is emitted right after LifecycleCtx (its dependency).
    parts.push(emitInterface(iface));
    if (iface.name === 'LifecycleCtx') {
      const hook = TYPE_ALIASES.find((a) => a.name === 'LifecycleHook');
      if (hook) parts.push(emitAlias(hook));
    }
  }

  // Patch interface.
  parts.push(`// ── Main Patch interface ──`);
  parts.push(`/**
 * A ccpatch patch module's \`default\` export.
 *
 * Required: \`description\`, \`verify\`, and either \`apply\` (for kind='free') or
 * \`target\` + \`code\`/\`transform\` (for declarative kinds).
 *
 * This interface is the permissive superset (every shape field is optional). For
 * a tighter, kind-aware contract that enforces the right field set, annotate the
 * patch with the \`PatchInput\` discriminated union (DeclarativePatch | FreePatch
 * | BootPatch) emitted below.
 */
export interface Patch {${emitSectionedFields(PATCH_FIELDS)}
}`);

  // Author-facing discriminated shapes (PatchCommon / DeclarativePatch /
  // FreePatch / BootPatch / PatchInput). Verbatim from the schema; must come
  // after Patch (PatchCommon = Omit<Patch, …>).
  parts.push(`// ── Discriminated patch shapes (kind-aware author contract) ──`);
  parts.push(PATCH_SHAPE_BLOCK);

  // NormalizedPatch interface.
  parts.push(`/** Normalized form returned by validateManifest(). */
export interface NormalizedPatch {
${NORMALIZED_FIELDS.map((f) => `  ${f.name}: ${f.type};`).join('\n')}
}`);

  // ManifestValidation result.
  parts.push(`/** Result of validateManifest(). */
export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  normalized: NormalizedPatch;
}`);

  return parts.join('\n\n') + '\n';
}

const generated = generate();
const current = (() => {
  try { return readFileSync(TYPES, 'utf8'); } catch { return null; }
})();

if (mode === 'write') {
  if (generated !== current) {
    writeFileSync(TYPES, generated);
    console.log(`gen-types: wrote ${TYPES}`);
  } else {
    console.log('gen-types: types/patch.d.ts already up to date.');
  }
  process.exit(0);
}

// check mode
if (generated !== current) {
  console.error('gen-types: types/patch.d.ts is out of sync with runner/manifest-schema.mjs.');
  console.error('Fix: run `npm run gen:types -- --write`, review the diff, commit.');
  process.exit(1);
}
console.log('gen-types: types/patch.d.ts is in sync with the schema.');

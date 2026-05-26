#!/usr/bin/env node
/**
 * codemod-declarative.mjs — proof-of-concept codemod that rewrites a
 * single-function-override patch from free-form apply() to declarative
 * kind: 'transpiler'.
 *
 * SCOPE (deliberately narrow):
 *   Only handles Pattern A — patches that look like:
 *
 *     import { findFunctionByLiteral } from '../runner/ast-anchor.mjs';
 *     import { resolveAnchorLiteral } from '../runner/anchors.mjs';
 *
 *     export default {
 *       ...
 *       apply: (code) => {
 *         const fn = findFunctionByLiteral(code, resolveAnchorLiteral('NAME'));
 *         if (!fn) { ... return code; }
 *         code = code.slice(0, fn.start) + 'function ' + fn.name + '(){return !0}' + code.slice(fn.end);
 *         return code;
 *       },
 *     };
 *
 *   This maps mechanically to:
 *
 *     export default {
 *       ...
 *       kind: 'transpiler',
 *       target: { function: { literal: resolveAnchorLiteral('NAME') } },
 *       transform: (fnText) => fnText.replace(/^function\s+([\w$]+)/, 'function $1(){return !0}'),
 *     };
 *
 *   We use `transpiler` (not `prefix`) because we need to REPLACE the function
 *   body, not just inject at the head. `prefix` would prepend `return !0;` —
 *   semantically equivalent for the always-true override case, but the
 *   original code drops the entire body, so transpiler is the faithful
 *   translation. (`prefix` would be a smaller patch; we leave that
 *   optimization to a follow-up.)
 *
 * Usage:
 *   node scripts/codemod-declarative.mjs <patch-name>           # dry-run, prints diff
 *   node scripts/codemod-declarative.mjs <patch-name> --write   # apply in place
 *
 * Example:
 *   node scripts/codemod-declarative.mjs plan_mode_interview
 *
 * Anything beyond this single pattern is OUT OF SCOPE — author the patch
 * by hand.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
const write = args.includes('--write');

if (!name) {
  console.error('Usage: node scripts/codemod-declarative.mjs <patch-name> [--write]');
  process.exit(2);
}

const candidates = [
  resolve(ROOT, 'extensions', `${name}.mjs`),
  resolve(ROOT, 'core', `${name}.mjs`),
];
const filePath = candidates.find(existsSync);
if (!filePath) {
  console.error(`codemod: patch "${name}" not found in extensions/ or core/`);
  process.exit(1);
}

const src = readFileSync(filePath, 'utf8');

// Pattern A — single-function override via findFunctionByLiteral.
// Accept two shapes:
//   inline:    findFunctionByLiteral(code, resolveAnchorLiteral('NAME'))
//   via-local: const literal = resolveAnchorLiteral('NAME'); findFunctionByLiteral(code, literal);
const inlineRe =
  /findFunctionByLiteral\(\s*code\s*,\s*resolveAnchorLiteral\(\s*['"]([\w$]+)['"]\s*\)\s*\)/;
const viaLocalRe =
  /resolveAnchorLiteral\(\s*['"]([\w$]+)['"]\s*\)\s*;[\s\S]{0,200}?findFunctionByLiteral\(\s*code\s*,\s*[A-Za-z_$][\w$]*\s*\)/;
const sliceConcatRe =
  /code\s*=\s*code\.slice\(0,\s*[A-Za-z_$][\w$]*\.start\)\s*\+\s*'function '\s*\+\s*[A-Za-z_$][\w$]*\.name\s*\+\s*'\(\)\{return !0\}'\s*\+\s*code\.slice\([A-Za-z_$][\w$]*\.end\)/;

// Reject multi-anchor patches — codemod handles one function only.
const literalCallCount = (src.match(/findFunctionByLiteral\(/g) || []).length;
if (literalCallCount > 1) {
  console.error(`codemod: ${name} overrides ${literalCallCount} functions — only single-anchor patches are auto-convertible.`);
  process.exit(1);
}

const lit = src.match(inlineRe) || src.match(viaLocalRe);
if (!lit) {
  console.error(`codemod: ${name} does not match Pattern A (findFunctionByLiteral + resolveAnchorLiteral).`);
  console.error('         Convert this patch by hand — see CONTRIBUTING.md "Declarative kinds".');
  process.exit(1);
}
if (!sliceConcatRe.test(src)) {
  console.error(`codemod: ${name} has a Pattern A anchor but the slice/concat form differs.`);
  console.error('         Convert this patch by hand.');
  process.exit(1);
}

const anchorName = lit[1];

// Build replacement. We:
//   1. drop the apply() block + the two helper imports (if unused elsewhere).
//   2. insert kind/target/transform fields just before the closing `};`.
//
// We keep `resolveAnchorLiteral` (still used in target.function.literal).

let out = src;

// 1. Strip the `import { findFunctionByLiteral } ...` line.
out = out.replace(/^import\s*\{\s*findFunctionByLiteral\s*\}\s*from\s*['"][^'"]+['"];\s*\n/m, '');

// 2. Rip out the existing apply: (code) => { ... }, block.
//    Use a balanced-brace scanner since the body has its own braces.
const applyStart = out.search(/\n\s*apply\s*:\s*\(code\)\s*=>\s*\{/);
if (applyStart === -1) {
  console.error(`codemod: ${name} — could not locate apply: (code) => { … } block.`);
  process.exit(1);
}
const openBrace = out.indexOf('{', applyStart);
let depth = 1, i = openBrace + 1;
while (i < out.length && depth > 0) {
  const c = out[i];
  if (c === '{') depth++;
  else if (c === '}') depth--;
  i++;
}
if (depth !== 0) {
  console.error(`codemod: ${name} — unbalanced braces in apply().`);
  process.exit(1);
}
// Swallow trailing `,` and newline.
let endIdx = i;
while (out[endIdx] === ',' || out[endIdx] === '\n') endIdx++;

const declarative =
`  kind: 'transpiler',
  target: { function: { literal: resolveAnchorLiteral('${anchorName}') } },
  // Replace the entire function body with \`return !0\` (always-true override).
  transform: (fnText) => fnText.replace(
    /function\\s+([\\w$]+)\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*\\}/,
    'function $1(){return !0}'
  ),
`;

out = out.slice(0, applyStart + 1) + declarative + out.slice(endIdx);

if (out === src) {
  console.error(`codemod: ${name} — no change produced. (Already declarative?)`);
  process.exit(1);
}

if (write) {
  writeFileSync(filePath, out, 'utf8');
  console.log(`codemod: rewrote ${filePath} → kind:"transpiler" (anchor=${anchorName})`);
  console.log('Next: run `npm run test:patches` to confirm verification still passes.');
} else {
  console.log(`--- ${filePath} (before)`);
  console.log(`+++ ${filePath} (after, kind:"transpiler", anchor=${anchorName})`);
  console.log('');
  console.log(out);
  console.log('');
  console.log('Dry-run only — re-run with --write to apply.');
}

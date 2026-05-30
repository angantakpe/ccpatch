#!/usr/bin/env node
/**
 * lint-anchors — enforce the resilient-anchor path across the registry.
 *
 * Each entry in runner/anchors.mjs may resolve via several precedence tiers
 * (see the resolveAnchor() docs atop that file):
 *   1. version-specific regex   2. refmap   3. anchors[] tier chain   4. default
 *
 * An entry that carries ONLY a `default` regex — an exact minified shape — is
 * brittle: a single upstream whitespace/arg change breaks it with no fallback.
 * The resilience infrastructure (a stable `literal` for AST resolution, or a
 * multi-tier `anchors:[]` chain) exists, but is useless on entries that don't
 * adopt it.
 *
 * This gate flags every entry that has a `default` but NEITHER a `literal` NOR
 * a non-empty `anchors:[]` tier chain, and exits non-zero so `npm run lint`
 * fails on it. Fix by adding the stable string the regex already references as
 * the entry's `literal` (giving it the AST-literal fallback path), or by
 * declaring an `anchors:[]` tier chain.
 *
 * ─── Second reach: inline anchors in patch files ──────────────────────────────
 * The registry covers only the handful of anchors that opted into it. Most
 * patches still carry inline regex/RegExp anchors in core/*.mjs and
 * extensions/*.mjs. Those are fine when they pin STABLE tokens (feature-flag
 * string literals, fixed JS syntax) but brittle when they pin a rotating
 * MINIFIED identifier (e.g. `function szH(){…}` or a `Z$(` helper call) — a
 * single upstream minifier reshuffle silently breaks them.
 *
 * scanPatchFiles() parses each patch file with Acorn (so comments and division
 * never masquerade as regex literals), extracts every RegExp literal and
 * `RegExp("…")` string argument, and flags patterns that pin a short literal
 * identifier (1-3 ident chars, optional trailing digits) in a JS name position:
 *   - `function <NAME>` where NAME is a literal short identifier, or
 *   - a bare `<NAME>\(` helper call (escaped paren ⇒ a literal call in the
 *     matched bundle text).
 * It deliberately does NOT flag the resilient escape hatches the codebase uses
 * for rotating names — capture groups / character classes like `(\w+)` or
 * `([A-Za-z_$][\w$]*)` — nor stable feature-flag string literals, JS reserved
 * words, or member-accessed/standard API names (`.map(`, `rgb(`, etc.).
 *
 * Usage:
 *   node scripts/lint-anchors.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import { anchors } from '../runner/anchors.mjs';

/** Does the entry declare a usable, non-empty anchors[] tier chain? */
function hasTierChain(entry) {
  return Array.isArray(entry.anchors)
    && entry.anchors.some((t) => t && t.pattern instanceof RegExp);
}

/**
 * Is this entry brittle — a `default` regex with no resilient fallback path?
 * Resilient means it carries a stable `literal` (AST resolution) OR a non-empty
 * `anchors:[]` tier chain. Entries with no `default` are not brittle (nothing to
 * harden).
 *
 * @param {object} entry
 * @returns {boolean}
 */
export function isBrittle(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!(entry.default instanceof RegExp)) return false;
  const hasLiteral = typeof entry.literal === 'string' && entry.literal.length > 0;
  return !(hasLiteral || hasTierChain(entry));
}

/** Return the ids of every brittle entry in a registry object. */
export function findOffenders(registry) {
  return Object.entries(registry)
    .filter(([, entry]) => isBrittle(entry))
    .map(([id]) => id);
}

/** Report offenders for `registry`; returns the process exit code (0 clean, 1 brittle). */
export function report(registry) {
  const offenders = findOffenders(registry);
  if (offenders.length === 0) {
    console.log(`lint-anchors: clean (${Object.keys(registry).length} entries, 0 brittle)`);
    return 0;
  }
  console.error(
    `lint-anchors: ${offenders.length} brittle entr${offenders.length === 1 ? 'y' : 'ies'} ` +
    `(default regex with no \`literal\` and no \`anchors:[]\` fallback chain)\n`
  );
  for (const id of offenders) {
    console.error(`  - ${id}: only a \`default\` regex — add the stable string it already`);
    console.error(`      references as \`literal\`, or declare an \`anchors:[]\` tier chain.`);
  }
  console.error(`\n  See the resolveAnchor() precedence docs atop runner/anchors.mjs.`);
  return 1;
}

// ─── Inline-anchor scanner ────────────────────────────────────────────────────

// JS reserved words + the handful of language tokens that legitimately appear
// as short `name(` / `function name` shapes inside matched bundle text. These
// are stable syntax, never minifier output, so they are not brittle pins.
const RESERVED = new Set([
  'if', 'for', 'do', 'in', 'of', 'new', 'try', 'var', 'let', 'return', 'function',
  'this', 'void', 'case', 'else', 'with', 'yield', 'await', 'async', 'switch',
  'while', 'const', 'class', 'catch', 'throw', 'super', 'typeof', 'delete',
  'instanceof', 'break', 'continue', 'default', 'export', 'import', 'extends', 'finally',
]);

/**
 * Inspect a single regex pattern source for brittle minified-identifier pins.
 * Returns a deduped list of `{ kind, name }` findings (empty when resilient).
 *
 * @param {string} source - The regex pattern source (RegExp.source or the
 *                          string passed to `new RegExp(...)`).
 * @returns {{ kind: 'function-name'|'helper-call', name: string }[]}
 */
export function findBrittlePins(source) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const out = [];
  const seen = new Set();
  const add = (kind, name) => {
    const k = kind + ':' + name;
    if (seen.has(k) || RESERVED.has(name)) return;
    seen.add(k);
    out.push({ kind, name });
  };

  // (a) function-name pins: `function ` followed by a LITERAL short identifier
  // (1–3 ident chars + optional trailing digits). A capture group / character
  // class (`function (\w+)`, `function ([A-Za-z_$]…)`) starts with `(` or `[`
  // and is excluded by the leading [A-Za-z_$] requirement.
  const fnRe = /function ([A-Za-z_$][\w$]{0,2}\d*)(?![\w$])/g;
  let m;
  while ((m = fnRe.exec(source)) !== null) add('function-name', m[1]);

  // (b) helper-call pins: a BARE short literal identifier immediately calling
  // via an escaped paren `\(`. The leading negative class excludes:
  //   - capture-group / class tails ( ) ] \w $ ) → resilient name slots,
  //   - member access `.name(` and string-literal content `"name(` / `'name(`
  //     → standard API surface (.map, .all, rgb), not minified module helpers.
  // A `[A-Za-z_$]\$` alternative catches the `Z$`-style 1-char-plus-`$` names.
  const callRe = /(^|[^\w$\]).\x22\x27])([A-Za-z_$][\w$]{0,2}\d*|[A-Za-z_$]\\\$)\\\(/g;
  while ((m = callRe.exec(source)) !== null) {
    const at = m.index + m[1].length;
    // Also skip escaped member access `\.name(`.
    if (source.slice(Math.max(0, at - 2), at) === '\\.') continue;
    add('helper-call', m[2].replace(/\\\$/, '$'));
  }
  return out;
}

/** Extract every RegExp literal / RegExp(string) pattern source from `src`. */
function extractPatterns(src) {
  const pats = [];
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return pats; // unparseable file — skip (other tooling will flag it)
  }
  const fromRegExpCall = (n) => {
    if (n.callee?.name === 'RegExp'
      && n.arguments[0]?.type === 'Literal'
      && typeof n.arguments[0].value === 'string') {
      pats.push(n.arguments[0].value);
    }
  };
  walkSimple(ast, {
    Literal(n) { if (n.regex) pats.push(n.regex.pattern); },
    NewExpression: fromRegExpCall,
    CallExpression: fromRegExpCall,
  });
  return pats;
}

/**
 * Scan patch files under the given dirs for brittle inline anchors.
 *
 * @param {string} root - repo root (dir containing core/ and extensions/)
 * @param {string[]} [dirs] - subdirs to scan
 * @returns {{ file: string, source: string, pins: object[] }[]}
 */
export function scanPatchFiles(root, dirs = ['core', 'extensions']) {
  const offenders = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    let entries;
    try { entries = readdirSync(abs); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.mjs')) continue;
      const rel = `${dir}/${f}`;
      const src = readFileSync(path.join(abs, f), 'utf8');
      for (const pat of extractPatterns(src)) {
        const pins = findBrittlePins(pat);
        if (pins.length) offenders.push({ file: rel, source: pat, pins });
      }
    }
  }
  return offenders;
}

/**
 * Report brittle inline anchors found by scanPatchFiles. Returns the exit code
 * contribution (0 clean, 1 brittle). Mirrors report()'s style.
 */
export function reportInline(root) {
  const offenders = scanPatchFiles(root);
  if (offenders.length === 0) {
    console.log('lint-anchors: inline scan clean (no brittle minified-identifier anchors)');
    return 0;
  }
  console.error(
    `lint-anchors: ${offenders.length} brittle inline anchor${offenders.length === 1 ? '' : 's'} ` +
    `(regex pins a rotating minified identifier instead of a stable literal)\n`
  );
  for (const o of offenders) {
    const names = o.pins.map((p) => `${p.name} (${p.kind})`).join(', ');
    console.error(`  - ${o.file}: pins ${names}`);
    console.error(`      /${o.source.length > 70 ? o.source.slice(0, 70) + '…' : o.source}/`);
  }
  console.error(
    `\n  Re-anchor on the stable string literal the bundle keeps across versions` +
    `\n  (capture rotating names with a group like ([A-Za-z_$][\\w$]*) ), the way` +
    `\n  runner/patch-helpers.mjs forceFeatureFlag() / extensions/durable_cron.mjs do.`
  );
  return 1;
}

// Run as a gate only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const registryCode = report(anchors);
  const inlineCode = reportInline(root);
  process.exit(registryCode || inlineCode);
}

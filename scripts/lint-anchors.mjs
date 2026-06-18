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
 * ─── Third reach: the minified-shape gate (literal/AST is the DEFAULT) ─────────
 * reportMinified()/scanMinifiedShapeAnchors() enforce that literal/AST anchoring
 * is the default for inline regex. Any regex that pins MINIFIED SHAPE — boolean
 * flags `!0`/`!1`, bare `\w+` quantifiers, `[A-Za-z_$][\w$]*` name slots — but
 * carries NO stable string/property literal to pivot on FAILS the gate, unless
 * its exact source is listed in ALLOWED_REGEX_ANCHORS. That allowlist is the
 * single, explicit, monotonically-shrinking home for raw minified-shape regex;
 * a brand-new such anchor fails CI until it is re-anchored on a stable literal.
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

// ─── Minified-shape anchor gate ───────────────────────────────────────────────
//
// The CANONICAL anchoring strategy (docs/anchors.md §1) pivots on a stable
// string literal the minifier cannot rename — a feature-flag key, error
// message, or property-name skeleton. An inline regex that instead pins the
// MINIFIED SHAPE of a function (boolean flags `!0`/`!1`, bare `\w+` name slots,
// `[A-Za-z_$][\w$]*` capture groups) WITHOUT carrying any such stable token is
// matching minifier output directly: one upstream reshuffle silently breaks it,
// and there is nothing for findFunctionByLiteral() to pivot on.
//
// This gate makes literal/AST anchoring the ENFORCED default for inline regex:
// every minified-shape-only anchor must either (a) carry a stable literal /
// property name, or (b) be listed in ALLOWED_REGEX_ANCHORS below. The allowlist
// is the single, explicit home for raw minified-shape regex and may only SHRINK
// — never add to it. Migrate an entry out by re-anchoring on the stable literal
// the bundle keeps (resolveAnchorLiteral + findFunctionByLiteral), then delete
// its line here.
//
// Heuristic for "carries a stable literal": the pattern source contains either a
// quoted string literal of >= 3 word chars, or a >= 4-char identifier/property
// word that is NOT a structural JS keyword (so `apiKey:`/`subagent_type:`/
// `isHidden`/`projectRoot` count, but `function`/`return`/`async` do not). Such
// words survive minification because they are object keys or API names.

// Structural JS keywords that appear as literal text in a function-shape regex
// but are NOT minifier-stable identifiers — they must not count as a "stable
// literal" that exempts a pattern from the gate.
const STRUCTURAL_WORDS = new Set([
  'function', 'return', 'async', 'await', 'this', 'null', 'true', 'false',
  'void', 'new', 'let', 'var', 'const', 'for', 'typeof', 'delete', 'instanceof',
  'in', 'of', 'do', 'if', 'else', 'while', 'switch', 'case', 'break', 'continue',
  'try', 'catch', 'throw', 'finally', 'class', 'extends', 'super', 'yield',
  // Universally-present runtime/Array/Promise surface — present in EVERY bundle
  // regardless of the patch's target, so it does not localise an anchor.
  'length', 'process', 'Promise', 'all', 'map', 'Object', 'Array', 'String',
  'globalThis', 'window', 'require', 'module', 'exports', 'prototype',
]);

// Tokens whose presence marks a regex as describing MINIFIED SHAPE rather than
// stable source text: boolean flags, bare `\w` quantifiers, name-slot classes.
const MINIFIED_SHAPE_RE = /!0|!1|\\w[*+]|\[A-Za-z_\$\]/;

/**
 * Extract the literal (non-meta) text a regex source pins on, dropping
 * character-class contents and escaped metacharacters so capture-group /
 * name-slot syntax (`[A-Za-z_$]`, `\w`, `\(`) never masquerades as a stable
 * token. Returns `{ quoted, words }`:
 *   quoted — true if a quoted string literal of >= 3 word chars is present
 *   words  — >= 4-char identifier/property words that are not structural keywords
 *
 * @param {string} src
 * @returns {{ quoted: boolean, words: string[] }}
 */
export function stableTokens(src) {
  // Walk the source, emitting only literal text: skip escaped metachars (\X) and
  // the *contents* of character classes [ ... ].
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\\') { out += ' '; i += 2; continue; }
    if (c === '[') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === ']') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  const quoted = /"[^"]{3,}"|'[^']{3,}'/.test(src);
  const words = (out.match(/[A-Za-z][A-Za-z0-9_$]{3,}/g) ?? [])
    .filter((w) => !STRUCTURAL_WORDS.has(w));
  return { quoted, words };
}

/**
 * Classify a single regex pattern source. Returns a reason string when the
 * pattern is a minified-shape anchor with no stable literal to pivot on, else
 * null (resilient — carries a stable token, or is not a function-shape anchor).
 *
 * @param {string} source
 * @returns {string|null}
 */
export function findMinifiedShapeAnchor(source) {
  if (typeof source !== 'string' || source.length === 0) return null;
  if (!MINIFIED_SHAPE_RE.test(source)) return null; // not a minified-shape regex
  const { quoted, words } = stableTokens(source);
  if (quoted) return null;          // anchored on a quoted string literal
  if (words.length > 0) return null; // anchored on a stable identifier/property word
  return 'minified-shape regex with no stable string/property literal to anchor on';
}

// Prefer anchor.allowRegex: true in the patch manifest over adding to this list.

/**
 * Check if a patch file's manifest has `anchor.allowRegex === true` set via
 * static AST analysis. Returns true when the default export object literal
 * contains an `anchor` property with a nested `allowRegex: true` boolean.
 * This keeps the scan synchronous (no dynamic import needed).
 *
 * @param {string} src - the patch file source text
 * @returns {boolean}
 */
export function patchManifestAllowsRegex(src) {
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return false;
  }
  // Walk for: export default { ..., anchor: { ..., allowRegex: true }, ... }
  let found = false;
  walkSimple(ast, {
    ExportDefaultDeclaration(node) {
      const obj = node.declaration;
      if (obj?.type !== 'ObjectExpression') return;
      for (const prop of obj.properties) {
        if (prop.type !== 'Property') continue;
        const key = prop.key?.name ?? prop.key?.value;
        if (key !== 'anchor') continue;
        const val = prop.value;
        if (val?.type !== 'ObjectExpression') continue;
        for (const inner of val.properties) {
          if (inner.type !== 'Property') continue;
          const innerKey = inner.key?.name ?? inner.key?.value;
          if (innerKey !== 'allowRegex') continue;
          if (inner.value?.type === 'Literal' && inner.value.value === true) {
            found = true;
          }
        }
      }
    },
  });
  return found;
}

/**
 * The explicit, monotonically-SHRINKING allowlist of raw minified-shape regex
 * anchors. Keyed by patch file (relative to repo root) → Set of exact regex
 * pattern sources. Every pattern here matches minifier output directly and has
 * no stable literal; it is grandfathered ONLY because a stable sibling anchor in
 * the same file scopes it (or it is a post-apply self-check, not a locator).
 *
 * ⚠️  This set may only SHRINK. Do NOT add entries. A new minified-shape anchor
 *    must instead re-anchor on a stable literal (see docs/anchors.md §1). Remove
 *    an entry once its pattern carries a stable token or is deleted.
 */
export const ALLOWED_REGEX_ANCHORS = {
  // onAfterApply() self-check window — NOT a locator. The primary anchor in this
  // file (`guardRe`) is stable-string-anchored on "progress"/"attachment".
  // v2.1.181: the normalizer parameter rotated from H to e, so the self-check
  // regex no longer hard-codes the param (it is now a name-slot class too).
  'core/message_normalizer.mjs': new Set([
    'function [A-Za-z_$][\\w$]*\\([A-Za-z_$][\\w$]*\\)\\{$',
  ]),
  // Secondary matches scoped by the file's stable property-skeleton anchor
  // (`async call({prompt:…,subagent_type:…,description:…})`).
  'extensions/expose_agent_tool.mjs': new Set([
    'function ([A-Za-z_$][\\w$]*)\\(\\)\\{return\\[([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*),',
    'let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(\\);for\\(let ([A-Za-z_$][\\w$]*)=0;\\3<([A-Za-z_$][\\w$]*)\\.length;\\3\\+\\+\\)\\{',
    'let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(\\);for\\(let ([A-Za-z_$][\\w$]*)=0;\\3<C\\.length;\\3\\+\\+\\)\\{',
  ]),
  // Secondary closer match, scoped to follow the stable factory-param skeleton
  // (`async function …({apiKey:…,maxRetries:…,model:…,fetchOverride:…,source:…})`).
  'extensions/expose_api_client.mjs': new Set([
    'return new ([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*)\\)\\}async function ([A-Za-z_$][\\w$]*)\\(',
  ]),
};

/** Is `source` an allowlisted raw minified-shape anchor for `relFile`? */
function isAllowedRegexAnchor(relFile, source) {
  return ALLOWED_REGEX_ANCHORS[relFile]?.has(source) ?? false;
}

/**
 * Extract every RegExp literal / RegExp(string) pattern source from `src`.
 * Parses with Acorn so comments and division never masquerade as regex.
 * Exported for reuse by scripts/anchor-report.mjs.
 * @param {string} src
 * @returns {string[]}
 */
export function extractPatterns(src) {
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
 * Scan patch files for raw minified-shape anchors not covered by the allowlist.
 * An offender is any regex flagged by findMinifiedShapeAnchor() whose source is
 * not present in ALLOWED_REGEX_ANCHORS for that file.
 *
 * @param {string} root - repo root (dir containing core/ and extensions/)
 * @param {string[]} [dirs] - subdirs to scan
 * @returns {{ file: string, source: string, reason: string }[]}
 */
export function scanMinifiedShapeAnchors(root, dirs = ['core', 'extensions']) {
  const offenders = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    let entries;
    try { entries = readdirSync(abs); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.mjs')) continue;
      const rel = `${dir}/${f}`;
      const src = readFileSync(path.join(abs, f), 'utf8');
      // Per-patch opt-in: anchor.allowRegex: true in the manifest exempts the
      // entire file from the minified-shape gate (same effect as ALLOWED_REGEX_ANCHORS).
      if (patchManifestAllowsRegex(src)) continue;
      for (const pat of extractPatterns(src)) {
        const reason = findMinifiedShapeAnchor(pat);
        if (reason && !isAllowedRegexAnchor(rel, pat)) {
          offenders.push({ file: rel, source: pat, reason });
        }
      }
    }
  }
  return offenders;
}

/**
 * Report raw minified-shape anchors that are neither stable-literal-anchored nor
 * allowlisted. Returns the exit-code contribution (0 clean, 1 offending).
 * This is the gate that makes literal/AST anchoring the enforced default.
 */
export function reportMinified(root) {
  const offenders = scanMinifiedShapeAnchors(root);
  if (offenders.length === 0) {
    console.log('lint-anchors: minified-shape scan clean (every inline anchor carries a stable literal or is allowlisted)');
    return 0;
  }
  console.error(
    `lint-anchors: ${offenders.length} raw minified-shape anchor${offenders.length === 1 ? '' : 's'} ` +
    `not anchored on a stable literal and not in ALLOWED_REGEX_ANCHORS\n`
  );
  for (const o of offenders) {
    console.error(`  - ${o.file}: ${o.reason}`);
    console.error(`      /${o.source.length > 70 ? o.source.slice(0, 70) + '…' : o.source}/`);
  }
  console.error(
    `\n  Re-anchor on the stable string the bundle keeps across versions and resolve` +
    `\n  the rotated function via findFunctionByLiteral() / resolveAnchorLiteral()` +
    `\n  (docs/anchors.md §1). The ALLOWED_REGEX_ANCHORS allowlist in` +
    `\n  scripts/lint-anchors.mjs is shrinking-only — do not add new entries.`
  );
  return 1;
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
  const minifiedCode = reportMinified(root);
  process.exit(registryCode || inlineCode || minifiedCode);
}

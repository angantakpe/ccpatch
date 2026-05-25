/**
 * runner/patch-helpers.mjs — Shared apply() building blocks.
 *
 * These helpers extract the three patterns that recur across patches:
 *
 *   1. spliceBoot(code, snippet)
 *      "Inject this snippet as early in the bundle as possible" — prepends to
 *      the shebang on Node-script bundles, or after the CJS IIFE header on
 *      npm-distributed bundles. Replaces the hand-rolled branching seen in
 *      core/fetch_interceptor.mjs, extensions/debug.mjs, etc.
 *
 *   2. spliceAfter(code, anchor, snippet, { allowMissing })
 *      "Insert `snippet` immediately after `anchor`" — a thin guard around the
 *      common `code.replace(anchor, anchor + snippet)` pattern that throws on
 *      missing or ambiguous anchors instead of silently no-oping.
 *
 *   3. replaceFunctionByLiteral(code, literal, build, opts)
 *      "Find the function containing this stable string literal, replace its
 *      body via build(fnName, currentBody)." Used by the durable_cron /
 *      loop_dynamic / plan_mode_interview family. Returns { code, fnName, hit }
 *      so callers can log + emit downstream snippets keyed off the resolved
 *      name.
 *
 * Existing patches do NOT need to migrate. New patches should prefer these
 * helpers — they throw on drift (rather than returning unchanged code) so
 * the strict-mode runner catches anchor misses immediately.
 */

import { findFunctionByLiteral } from './ast-anchor.mjs';

const SHEBANG = '#!/usr/bin/env node';
const CJS_IIFE = '(function(exports, require, module, __filename, __dirname)';

/**
 * Inject `snippet` at the earliest viable boot point in the bundle.
 *   - If a shebang is present, splice right after the newline that follows it.
 *   - Otherwise, if the CJS IIFE wrapper header is present, splice immediately
 *     before it (so the snippet runs in the outer scope, not the wrapper).
 *   - Otherwise throw — there is no safe boot anchor in this bundle.
 *
 * Idempotent only when `snippet` carries its own guard. The caller is
 * responsible for guarding against double-injection.
 *
 * @param {string} code
 * @param {string} snippet
 * @returns {string}
 */
export function spliceBoot(code, snippet) {
  if (typeof code !== 'string' || typeof snippet !== 'string') {
    throw new TypeError('spliceBoot: code and snippet must be strings');
  }
  if (code.includes(SHEBANG)) {
    const idx = code.indexOf(SHEBANG);
    const afterNl = code.indexOf('\n', idx);
    const at = afterNl === -1 ? idx + SHEBANG.length : afterNl + 1;
    return code.slice(0, at) + snippet + code.slice(at);
  }
  if (code.includes(CJS_IIFE)) {
    return code.replace(CJS_IIFE, snippet + CJS_IIFE);
  }
  throw new Error('spliceBoot: bundle has neither shebang nor CJS-IIFE anchor — no safe boot site');
}

/**
 * Insert `snippet` immediately after the first occurrence of `anchor`. Throws
 * if the anchor is missing (so the strict-mode runner catches drift) unless
 * `opts.allowMissing` is set.
 *
 * `anchor` may be a string or a RegExp. When a regex, the splice happens
 * after the matched substring (uses `anchor.exec`).
 *
 * @param {string} code
 * @param {string|RegExp} anchor
 * @param {string} snippet
 * @param {{ allowMissing?: boolean }} [opts]
 * @returns {string}
 */
export function spliceAfter(code, anchor, snippet, opts = {}) {
  if (typeof code !== 'string') throw new TypeError('spliceAfter: code must be a string');
  if (typeof snippet !== 'string') throw new TypeError('spliceAfter: snippet must be a string');

  if (typeof anchor === 'string') {
    const idx = code.indexOf(anchor);
    if (idx === -1) {
      if (opts.allowMissing) return code;
      throw new Error(`spliceAfter: anchor not found: ${anchor.slice(0, 80)}`);
    }
    const at = idx + anchor.length;
    return code.slice(0, at) + snippet + code.slice(at);
  }

  if (anchor instanceof RegExp) {
    // Force a non-sticky local copy so callers can pass /g without surprise.
    const re = new RegExp(anchor.source, anchor.flags.replace(/[gy]/g, ''));
    const m = re.exec(code);
    if (!m) {
      if (opts.allowMissing) return code;
      throw new Error(`spliceAfter: regex anchor not found: ${anchor.source.slice(0, 80)}`);
    }
    const at = m.index + m[0].length;
    return code.slice(0, at) + snippet + code.slice(at);
  }

  throw new TypeError('spliceAfter: anchor must be string or RegExp');
}

/**
 * Locate the function containing `literal` (via findFunctionByLiteral) and
 * replace its body. `build(fnName, currentText)` should return the full
 * replacement function declaration — typically `function ${fnName}(){return !0}`.
 *
 * Throws when the literal is missing (drift) unless `opts.allowMissing` is set,
 * in which case the original code is returned and the patch's `verify` block
 * will catch the regression.
 *
 * @param {string} code
 * @param {string} literal              - Stable string literal anchoring the fn
 * @param {(fnName: string, currentText: string) => string} build
 * @param {{ allowMissing?: boolean }} [opts]
 * @returns {{ code: string, fnName: string|null, hit: object|null, changed: boolean }}
 */
export function replaceFunctionByLiteral(code, literal, build, opts = {}) {
  if (typeof code !== 'string') throw new TypeError('replaceFunctionByLiteral: code must be a string');
  if (typeof literal !== 'string' || literal.length === 0) {
    throw new TypeError('replaceFunctionByLiteral: literal must be a non-empty string');
  }
  if (typeof build !== 'function') {
    throw new TypeError('replaceFunctionByLiteral: build must be a function');
  }

  const hit = findFunctionByLiteral(code, literal);
  if (!hit) {
    if (opts.allowMissing) return { code, fnName: null, hit: null, changed: false };
    throw new Error(`replaceFunctionByLiteral: no function wraps literal "${literal.slice(0, 60)}"`);
  }
  const currentText = code.slice(hit.start, hit.end);
  const replacement = build(hit.name, currentText);
  if (typeof replacement !== 'string') {
    throw new TypeError(`replaceFunctionByLiteral: build() must return a string (got ${typeof replacement})`);
  }
  const nextCode = code.slice(0, hit.start) + replacement + code.slice(hit.end);
  return { code: nextCode, fnName: hit.name, hit, changed: nextCode !== code };
}

/**
 * Specialization of replaceFunctionByLiteral for the most common case:
 * "force this feature-flag function to return true." Captures the durable_cron
 * / loop_dynamic / unhide_features pattern in one line.
 *
 *   forceFeatureFlag(code, 'tengu_kairos_cron_durable') // → returns { code, fnName }
 *
 * @param {string} code
 * @param {string} literal
 * @param {{ value?: '!0'|'!1'|string, allowMissing?: boolean }} [opts]
 */
export function forceFeatureFlag(code, literal, opts = {}) {
  const value = opts.value ?? '!0';
  return replaceFunctionByLiteral(
    code,
    literal,
    (fnName) => `function ${fnName}(){return ${value}}`,
    { allowMissing: opts.allowMissing },
  );
}

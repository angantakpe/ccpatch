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
 *   4. registerFetchHook(name, handlerSource, priority) + FETCH_PRIORITY
 *      Builds the canonical `globalThis.__ccpOnFetchBefore(name, handler, prio)`
 *      subscriber wiring as a string snippet, with NAMED priority tiers instead
 *      of the magic numbers (15/80/5/…) the ~8 fetch-hook extensions hand-wrote.
 *
 *   5. injectAtModuleTop(code, snippet, opts)
 *      Dual-anchor (shebang OR CJS-IIFE) module-top injection in one place, with
 *      a `placement: 'before' | 'after'` knob covering both the spliceBoot /
 *      extended_thinking shape and the model.mjs (after-the-IIFE) shape, and a
 *      fail-open `onMissing: 'warn'` default matching the hand-rolled patches.
 *
 * Existing patches do NOT need to migrate. New patches should prefer these
 * helpers — the strict ones (spliceAfter / replaceFunctionByLiteral) throw on
 * drift so the runner catches anchor misses immediately.
 */

import { findFunctionByLiteral } from './ast-anchor.mjs';

const SHEBANG = '#!/usr/bin/env node';
const CJS_IIFE = '(function(exports, require, module, __filename, __dirname)';
// The IIFE header as it appears in npm bundles, WITH the opening brace. Some
// hand-rolled patches matched `…__dirname) {` (brace included) and spliced the
// snippet AFTER it (inside the wrapper scope); others matched without the brace
// and spliced BEFORE it (outer scope). injectAtModuleTop() supports both.
const CJS_IIFE_BRACE = '(function(exports, require, module, __filename, __dirname) {';

/**
 * Named priority tiers for `globalThis.__ccpOnFetchBefore(name, handler, priority)`.
 *
 * Semantics come from core/fetch_interceptor.mjs: subscribers are kept sorted
 * ascending by priority and **lower number = called first**; the default is 50.
 *
 * These names replace the scattered magic numbers hand-written at each call
 * site. Values are derived from the priorities actually in use across the
 * extension set at migration time:
 *
 *   0  → policy_gate (fail-closed), mcp_lazy   → GATE   (run before everything)
 *   15 → extended_thinking                     → EARLY
 *   20 → policy_gate (normal inspect)          → INSPECT
 *   40 → tool_result_trim                      → TRIM
 *   50 → fetch_interceptor default             → DEFAULT
 *   80 → context_budget_warn                   → LATE   (after body rewrites)
 *   95 → rate_limit                            → LAST   (throttle the final body)
 *
 * Prefer a named tier over a bare integer at new call sites. Callers needing a
 * value between tiers may still pass a literal number to `registerFetchHook`.
 */
export const FETCH_PRIORITY = Object.freeze({
  GATE: 0,
  EARLY: 15,
  INSPECT: 20,
  TRIM: 40,
  DEFAULT: 50,
  LATE: 80,
  LAST: 95,
});

/**
 * Inject `snippet` at the earliest viable boot point in the bundle.
 *   - If the bundle STARTS WITH a shebang, splice right after the newline that
 *     follows it.
 *   - Otherwise, if the CJS IIFE wrapper header is present, splice immediately
 *     before it (so the snippet runs in the outer scope, not the wrapper).
 *   - Otherwise throw — there is no safe boot anchor in this bundle.
 *
 * The shebang is matched with startsWith(), NOT includes(): bundles extracted
 * from the Bun binary have no leading shebang but DO contain "#!/usr/bin/env
 * node" as an interior string literal (Anthropic's own hook-installer code), so
 * includes() would splice the snippet into the middle of the bundle as dead
 * string content instead of at the boot point.
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
  if (code.startsWith(SHEBANG)) {
    const afterNl = code.indexOf('\n');
    const at = afterNl === -1 ? SHEBANG.length : afterNl + 1;
    return code.slice(0, at) + snippet + code.slice(at);
  }
  if (code.includes(CJS_IIFE)) {
    // Use the function form of replace() so `$&`, `$'`, `$\`` and `$n` sequences
    // inside `snippet` are injected LITERALLY rather than expanded as String.replace
    // special replacement patterns. The string form `snippet + CJS_IIFE` would
    // mis-expand a snippet containing e.g. `$&` (→ the whole matched IIFE header),
    // ballooning the output (observed 15.5MB→62MB for the event_bus hook).
    return code.replace(CJS_IIFE, () => snippet + CJS_IIFE);
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

/**
 * Build the canonical `globalThis.__ccpOnFetchBefore(...)` subscriber wiring as
 * a string snippet, ready to splice into a bundle. Factors out the boilerplate
 * that ~8 extensions hand-wrote (the `typeof … === 'function'` guard + the
 * registration call + a magic priority number).
 *
 * The emitted snippet:
 *   - guards on `typeof globalThis.__ccpOnFetchBefore === 'function'` so it is a
 *     no-op when fetch_interceptor isn't installed (fail-open, rule 4);
 *   - registers `handlerSource` under `name` at the given `priority`;
 *   - does NOT wrap anything in try/catch — the CALLER is expected to wrap the
 *     whole module-top snippet (as every existing extension already does), and
 *     keeping this helper try/catch-free preserves byte-for-byte parity with the
 *     hand-written form it replaces.
 *
 * `handlerSource` is raw JS source for the handler — typically
 * `'function(ctx){ … }'` or `'async (ctx) => { … }'`. It is emitted verbatim.
 *
 * `priority` may be a `FETCH_PRIORITY.*` tier or a bare integer. Lower runs
 * first (see FETCH_PRIORITY). Defaults to `FETCH_PRIORITY.DEFAULT` (50), which
 * matches fetch_interceptor's own default.
 *
 * `opts.indent` is the leading whitespace for the wrapping `if`/`}` lines (the
 * registration call is indented two further spaces). It lets a migrated patch
 * reproduce its existing byte layout exactly — the hand-written extensions wrap
 * at a 2-space base indent (pass `indent: '  '`), and the multi-line handler's
 * own closing brace then lines up with the registration call. Default `''`.
 *
 * @param {string} name           - Stable subscriber name (also the verify anchor)
 * @param {string} handlerSource  - JS source of the handler function/arrow
 * @param {number} [priority]     - FETCH_PRIORITY tier or integer; default 50
 * @param {{ indent?: string }} [opts]
 * @returns {string}              - JS snippet (no leading/trailing newline)
 */
export function registerFetchHook(name, handlerSource, priority = FETCH_PRIORITY.DEFAULT, opts = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('registerFetchHook: name must be a non-empty string');
  }
  if (typeof handlerSource !== 'string' || handlerSource.length === 0) {
    throw new TypeError('registerFetchHook: handlerSource must be a non-empty string');
  }
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new TypeError('registerFetchHook: priority must be a finite number');
  }
  const indent = opts.indent ?? '';
  if (typeof indent !== 'string') {
    throw new TypeError('registerFetchHook: opts.indent must be a string');
  }
  return (
    `${indent}if (typeof globalThis.__ccpOnFetchBefore === 'function') {\n` +
    `${indent}  globalThis.__ccpOnFetchBefore('${name}', ${handlerSource}, ${priority});\n` +
    `${indent}}`
  );
}

/**
 * Inject `snippet` at the module top of the bundle, handling BOTH distribution
 * shapes in one place:
 *
 *   - Node-script bundle (starts with a shebang): splice the snippet right after
 *     the shebang line.
 *   - npm/CJS bundle (CJS IIFE wrapper present): splice the snippet relative to
 *     the IIFE header. `opts.placement` controls where:
 *       'before' (default) → snippet runs in the OUTER scope, immediately before
 *                            `(function(exports, …){`. Matches spliceBoot and the
 *                            extended_thinking hand-rolled form.
 *       'after'            → snippet runs INSIDE the wrapper, immediately after
 *                            `…__dirname) {`. Matches the model.mjs hand-rolled
 *                            form (env-var setup that wants the bundle's scope).
 *
 * On a miss (neither anchor present) the behaviour depends on `opts.onMissing`:
 *   'warn'  (default) → `console.warn('  [!] <label>: anchor not found …')` and
 *                       return `code` unchanged (rule 4 — never half-apply). This
 *                       matches the hand-rolled extensions being migrated.
 *   'throw'           → throw, for strict new patches that prefer loud drift.
 *
 * The shebang is matched with startsWith() (not includes()) for the same reason
 * spliceBoot documents: Bun-extracted bundles carry "#!/usr/bin/env node" as an
 * interior string literal that must not be treated as the boot point.
 *
 * The CJS branch uses the function form of String.replace so `$&`/`$n` sequences
 * inside `snippet` are injected literally (see spliceBoot for the 15.5MB→62MB
 * blow-up this avoids).
 *
 * Idempotency is the caller's responsibility — guard `snippet` with a sentinel.
 *
 * @param {string} code
 * @param {string} snippet
 * @param {{ placement?: 'before'|'after', onMissing?: 'warn'|'throw', label?: string }} [opts]
 * @returns {string}
 */
export function injectAtModuleTop(code, snippet, opts = {}) {
  if (typeof code !== 'string') throw new TypeError('injectAtModuleTop: code must be a string');
  if (typeof snippet !== 'string') throw new TypeError('injectAtModuleTop: snippet must be a string');

  const placement = opts.placement ?? 'before';
  if (placement !== 'before' && placement !== 'after') {
    throw new TypeError(`injectAtModuleTop: placement must be 'before' or 'after' (got ${placement})`);
  }
  const onMissing = opts.onMissing ?? 'warn';
  const label = opts.label ?? 'patch';

  if (code.startsWith(SHEBANG)) {
    return code.replace(SHEBANG, () => SHEBANG + snippet);
  }

  if (placement === 'after') {
    if (code.includes(CJS_IIFE_BRACE)) {
      return code.replace(CJS_IIFE_BRACE, () => CJS_IIFE_BRACE + snippet);
    }
  } else if (code.includes(CJS_IIFE)) {
    return code.replace(CJS_IIFE, () => snippet + CJS_IIFE);
  }

  if (onMissing === 'throw') {
    throw new Error('injectAtModuleTop: bundle has neither shebang nor CJS-IIFE anchor — no safe boot site');
  }
  console.warn(`  [!] ${label}: anchor not found (no shebang, no CJS-IIFE) — skipping`);
  return code;
}

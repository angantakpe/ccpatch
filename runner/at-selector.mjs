// runner/at-selector.mjs
//
// @At selector vocabulary — declarative anchors for ccpatch patches.
//
// Inspired by Minecraft Mixin's @At annotations. A patch may declare an `at`
// manifest field describing *where* in the bundle it wants to attach; the
// runner resolves it once before calling apply(), and passes the resolved
// byte ranges via patchOptions.atSites. The patch's apply() then uses the
// helpers exported here (injectAtHead etc.) to splice its fragment.
//
// Resolver contract:
//   resolveAt(at, code, opts)
//     → { ok: true,  sites: [{ start, end, kind, label }] }
//     → { ok: false, error: string, candidates?: fuzzyMatch[] }
//
// Selector kinds:
//   HEAD    — function entry. target.function = 'NAME' | { literal: 'STR' }.
//             site.start = offset just AFTER the opening brace of the body;
//             site.end   = same (insertion point, zero-length).
//   RETURN  — every `return` statement inside the target function.
//             site.start = offset of `return` keyword;
//             site.end   = offset of the terminating `;` (or `}` for void).
//             site.kind  = 'RETURN'; site.label includes `void` for `return;`.
//   INVOKE  — call site(s). target.call = 'fnName' | { literal: 'STR' }.
//             Optional target.occurrence (1-indexed) selects the Nth call only.
//             When target.in = function spec, scan only inside that function.
//             site.start/end span the entire CallExpression (`f(args)`).
//   BEFORE  — immediately before a string literal. target.literal, occurrence?.
//             site.start === site.end === literal_offset.
//   AFTER   — immediately after a string literal. target.literal, occurrence?.
//             site.start === site.end === literal_offset + literal.length.

import { findFunctionByLiteral, firstOffsetOf } from './ast-anchor.mjs';
import { fuzzyMatch } from './anchors.mjs';
import { findClosingBrace } from './brace-walker.mjs';
import { getAst } from './ast-cache.mjs';

export const AT_KINDS = Object.freeze(['HEAD', 'RETURN', 'INVOKE', 'BEFORE', 'AFTER']);

// Per-character classifiers via charCodeAt range comparisons (cf. the numeric
// charCodeAt keying in verify-batch.mjs). These run in tight backward/forward
// scan loops over the 16 MB bundle, so avoiding a RegExp.test() call (and the
// single-char string index `code[j]`) per byte is a measurable win. Behavior is
// identical to the regexes they replace.
//   isIdentChar   ↔ /[A-Za-z0-9_$]/   (callee-name char, no dot)
//   isIdentDotChar↔ /[A-Za-z0-9_$.]/  (member-chain char, includes dot)
function isIdentChar(cc) {
  return (
    (cc >= 48 && cc <= 57) ||  // 0-9
    (cc >= 65 && cc <= 90) ||  // A-Z
    (cc >= 97 && cc <= 122) || // a-z
    cc === 95 ||               // _
    cc === 36                  // $
  );
}
function isIdentDotChar(cc) {
  return isIdentChar(cc) || cc === 46; // adds '.'
}

/**
 * Resolve a function spec to a function body range.
 *   spec: 'fnName' | { literal: 'string' }
 * Returns { name, start, end, bodyStart, bodyEnd } or null. bodyStart is just
 * after the opening brace; bodyEnd is the offset of the closing brace.
 */
function resolveFunction(spec, code) {
  if (typeof spec === 'string') {
    // Search for `function NAME(` in the bundle. Naive but works for minified
    // code where names are short and unique enough; callers preferring a
    // stable string literal should use { literal: ... } form.
    const needle = `function ${spec}(`;
    // Memoized first-offset lookup (same per-code index findFunctionByLiteral
    // uses). resolveInvoke can resolve the same `function NAME(` again; this
    // avoids a second full-bundle scan. Identical result to code.indexOf(needle).
    const idx = firstOffsetOf(code, needle);
    if (idx === -1) return null;
    // Find the opening brace of the body.
    let i = idx + needle.length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    // Skip whitespace then expect '{'.
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '{') return null;
    const openBrace = i;
    const closeBrace = findClosingBrace(code, openBrace);
    if (closeBrace === -1) return null;
    return {
      name: spec,
      start: idx,
      end: closeBrace + 1,
      bodyStart: openBrace + 1,
      bodyEnd: closeBrace,
    };
  }
  if (spec && typeof spec === 'object' && typeof spec.literal === 'string') {
    const fn = findFunctionByLiteral(code, spec.literal);
    if (!fn) return null;
    // Recover bodyStart/bodyEnd by re-locating the first brace within [start,end].
    const openBrace = code.indexOf('{', fn.start);
    if (openBrace === -1 || openBrace >= fn.end) return null;
    // fn.end is the offset AFTER the closing brace.
    return {
      name: fn.name,
      start: fn.start,
      end: fn.end,
      bodyStart: openBrace + 1,
      bodyEnd: fn.end - 1,
    };
  }
  return null;
}

function fuzzyCandidatesForLiteral(code, literal) {
  if (typeof literal !== 'string' || literal.length < 4) return [];
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fuzzyMatch(code, new RegExp(escaped));
}

/**
 * Resolve a HEAD selector to a single zero-length insertion site after the
 * function's opening brace.
 */
function resolveHead(at, code) {
  const fn = resolveFunction(at.target?.function, code);
  if (!fn) {
    const lit = typeof at.target?.function === 'object' ? at.target.function.literal : null;
    return {
      ok: false,
      error: `HEAD: function not found (${describeFnSpec(at.target?.function)})`,
      candidates: lit ? fuzzyCandidatesForLiteral(code, lit) : [],
    };
  }
  return {
    ok: true,
    sites: [{
      start: fn.bodyStart,
      end: fn.bodyStart,
      kind: 'HEAD',
      label: `HEAD ${fn.name ?? '<anon>'}`,
    }],
  };
}

/**
 * Walk a function body and collect every ReturnStatement.
 * Uses Acorn over the extracted function text (cheap) instead of the bundle.
 */
function collectReturns(code, fn) {
  const fnText = code.slice(fn.start, fn.end);
  let ast;
  try {
    ast = getAst(code, fn.start, fn.end, fnText);
  } catch (_) {
    return null;
  }
  const sites = [];
  // Offsets in ast are relative to the wrapped string "(" + fnText + ")".
  // Wrapper adds 1 char before fnText. Bundle offset = fn.start + (astOffset - 1).
  const toBundle = (off) => fn.start + (off - 1);
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node.type === 'ReturnStatement') {
      const start = toBundle(node.start);
      const end = toBundle(node.end);
      const isVoid = node.argument == null;
      sites.push({
        start, end,
        kind: 'RETURN',
        label: isVoid ? 'RETURN void' : 'RETURN value',
        void: isVoid,
        // arg offsets help injectAtReturn rewrite `return X` precisely
        argStart: node.argument ? toBundle(node.argument.start) : null,
        argEnd: node.argument ? toBundle(node.argument.end) : null,
      });
    }
    // Do NOT recurse into nested functions — their returns belong to them.
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      // Skip nested function bodies, but visit the top-level wrapper expression.
      // The outer call passes the top-level FunctionExpression first; we walk
      // its body only.
      if (node !== walk.__root) return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'type') continue;
      walk(node[key]);
    }
  }
  // Locate the FunctionExpression root inside ast.body[0].expression
  const root = ast.body[0]?.expression;
  if (!root) return null;
  walk.__root = root;
  walk(root.body);
  return sites;
}

function resolveReturn(at, code) {
  const fn = resolveFunction(at.target?.function, code);
  if (!fn) {
    const lit = typeof at.target?.function === 'object' ? at.target.function.literal : null;
    return {
      ok: false,
      error: `RETURN: function not found (${describeFnSpec(at.target?.function)})`,
      candidates: lit ? fuzzyCandidatesForLiteral(code, lit) : [],
    };
  }
  const sites = collectReturns(code, fn);
  if (!sites) return { ok: false, error: `RETURN: failed to parse function ${fn.name ?? '<anon>'}` };
  if (sites.length === 0) return { ok: false, error: `RETURN: no return statements in ${fn.name ?? '<anon>'}` };
  return { ok: true, sites };
}

/**
 * INVOKE — find call sites for `target.call`. If target.in is given, scan only
 * within that function; otherwise scan the whole bundle (potentially expensive,
 * but no full Acorn parse — we use indexOf + bracket walking).
 */
function resolveInvoke(at, code) {
  const call = at.target?.call;

  let scanStart = 0;
  let scanEnd = code.length;
  if (at.target?.in) {
    const fn = resolveFunction(at.target.in, code);
    if (!fn) return { ok: false, error: `INVOKE: enclosing function not found (${describeFnSpec(at.target.in)})` };
    scanStart = fn.bodyStart;
    scanEnd = fn.bodyEnd;
  }

  let sites;
  let describeTarget;
  if (typeof call === 'string') {
    sites = findCallsByName(code, call, scanStart, scanEnd);
    describeTarget = `${call}()`;
  } else if (call && typeof call === 'object' && typeof call.literal === 'string') {
    // Literal-target INVOKE: resolve call sites whose ARGUMENT LIST contains the
    // stable string literal (Chose option (a) over the old stub). The old code
    // did `callName = call.literal` and searched for `STR(`, treating the literal
    // as the callee name — semantically wrong: a literal is meant to pin a call
    // by a stable string argument (minifiers rename identifiers but not string
    // literals), exactly the contract findFunctionByLiteral already relies on.
    // Resolving by argument is tractable from the existing bracket-walking
    // machinery (findMatchingParen), so we implement it correctly here rather
    // than silently resolving the wrong sites.
    sites = findCallsByLiteralArg(code, call.literal, scanStart, scanEnd);
    describeTarget = `call with literal ${JSON.stringify(call.literal.slice(0, 40))}`;
  } else {
    return { ok: false, error: 'INVOKE: target.call must be a string or { literal }' };
  }

  if (sites.length === 0) {
    return { ok: false, error: `INVOKE: no calls (${describeTarget}) found` };
  }

  if (at.target.occurrence !== undefined) {
    const n = at.target.occurrence;
    if (!Number.isInteger(n) || n < 1 || n > sites.length) {
      return { ok: false, error: `INVOKE: occurrence ${n} out of range (found ${sites.length} call(s))` };
    }
    return { ok: true, sites: [sites[n - 1]] };
  }
  return { ok: true, sites };
}

/**
 * Find all `name(args)` call sites in code[scanStart, scanEnd) where the callee
 * identifier is exactly `callName`. Returns INVOKE site objects.
 */
function findCallsByName(code, callName, scanStart, scanEnd) {
  const sites = [];
  const needle = callName + '(';
  let i = scanStart;
  while (i < scanEnd) {
    const idx = code.indexOf(needle, i);
    if (idx === -1 || idx >= scanEnd) break;
    // Ensure preceding char is not a word-char (so `foo(` doesn't match `barfoo(`).
    const prev = idx > 0 ? code[idx - 1] : '';
    if (/[A-Za-z0-9_$]/.test(prev)) { i = idx + 1; continue; }
    // Find matching ')'.
    const parenOpen = idx + callName.length;
    const parenClose = findMatchingParen(code, parenOpen);
    if (parenClose === -1) { i = idx + 1; continue; }
    sites.push({
      start: idx,
      end: parenClose + 1,
      kind: 'INVOKE',
      label: `INVOKE ${callName}`,
      argsStart: parenOpen + 1,
      argsEnd: parenClose,
    });
    i = parenClose + 1;
  }
  return sites;
}

/**
 * Find all call sites in code[scanStart, scanEnd) whose argument list contains
 * the stable string `literal` as a top-level argument. For each occurrence of
 * the quoted literal we walk left to the opening `(` of the enclosing call,
 * read back the callee identifier (or member expression tail), then walk the
 * matching `)` forward and confirm the literal actually sits inside the
 * argument range. This pins a call by its stable string argument rather than by
 * the (minifier-renamed) callee name.
 */
function findCallsByLiteralArg(code, literal, scanStart, scanEnd) {
  const quoted = JSON.stringify(literal); // double-quoted + escaped
  // Loop-invariant needles — built once, not per iteration.
  const single = "'" + literal.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const sites = [];
  const seen = new Set(); // dedupe by call start offset
  let from = scanStart;
  while (from < scanEnd) {
    let litIdx = code.indexOf(quoted, from);
    // Also try single-quoted form, taking whichever occurs first.
    const singleIdx = code.indexOf(single, from);
    if (singleIdx !== -1 && (litIdx === -1 || singleIdx < litIdx)) {
      litIdx = singleIdx;
    }
    if (litIdx === -1 || litIdx >= scanEnd) break;
    from = litIdx + 1;

    const call = enclosingCallAt(code, litIdx, scanStart, scanEnd);
    if (!call) continue;
    // Confirm the literal lies within the argument list of this call.
    if (litIdx < call.argsStart || litIdx >= call.argsEnd) continue;
    if (seen.has(call.start)) continue;
    seen.add(call.start);
    sites.push(call);
  }
  // Sites discovered in literal order; sort by position for stable occurrence
  // numbering matching source order.
  sites.sort((a, b) => a.start - b.start);
  return sites;
}

/**
 * Given an index `litIdx` known to fall inside a string literal, find the call
 * expression `callee(args)` that immediately encloses it (the literal being a
 * top-level argument). Returns an INVOKE site or null if no such call is found
 * within [scanStart, scanEnd).
 *
 * Strategy: scan backward from litIdx tracking paren depth (skipping nested
 * string literals) until we cross to depth -1 — that position is the opening
 * `(` of the enclosing call. The callee identifier is whatever word/member
 * tail precedes that `(`. We then forward-walk the matching `)` so the site
 * spans the whole call expression.
 */
function enclosingCallAt(code, litIdx, scanStart, scanEnd) {
  let depth = 0;
  let i = litIdx - 1;
  while (i >= scanStart) {
    const c = code[i];
    // Skip backward over a string literal if we land on its closing quote.
    if (c === '"' || c === "'" || c === '`') {
      const close = c;
      i--;
      while (i >= scanStart) {
        if (code[i] === close && code[i - 1] !== '\\') { i--; break; }
        i--;
      }
      continue;
    }
    if (c === ')') { depth++; i--; continue; }
    if (c === '(') {
      if (depth === 0) {
        // Opening paren of the enclosing call.
        const parenOpen = i;
        // Read the callee identifier/member just before the paren.
        let j = parenOpen - 1;
        while (j >= scanStart && /\s/.test(code[j])) j--;
        const calleeEnd = j + 1;
        // Callee is an identifier or member chain (a.b.c). Computed access
        // (obj[x]) and call-returning-call (f()()) are out of scope here.
        while (j >= scanStart && isIdentDotChar(code.charCodeAt(j))) j--;
        const calleeStart = j + 1;
        const callee = code.slice(calleeStart, calleeEnd);
        // No callee, or a leading dot (member tail with no base) → this is a
        // grouping paren `(...)`, not a call. Keep ascending to the next
        // enclosing paren at the same depth.
        if (!callee || callee.startsWith('.')) { i = parenOpen - 1; continue; }
        const parenClose = findMatchingParen(code, parenOpen);
        if (parenClose === -1 || parenClose > scanEnd) return null;
        return {
          start: calleeStart,
          end: parenClose + 1,
          kind: 'INVOKE',
          label: `INVOKE ${callee}`,
          argsStart: parenOpen + 1,
          argsEnd: parenClose,
        };
      }
      depth--;
      i--;
      continue;
    }
    i--;
  }
  return null;
}

function findMatchingParen(code, openPos) {
  if (code[openPos] !== '(') return -1;
  let depth = 1;
  let i = openPos + 1;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '`') {
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function resolveBeforeAfter(at, code, kind) {
  const lit = at.target?.literal;
  if (typeof lit !== 'string' || lit.length === 0) {
    return { ok: false, error: `${kind}: target.literal (non-empty string) required` };
  }
  const occurrence = at.target.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    return { ok: false, error: `${kind}: target.occurrence must be a positive integer` };
  }
  let idx = -1;
  let from = 0;
  for (let n = 0; n < occurrence; n++) {
    idx = code.indexOf(lit, from);
    if (idx === -1) break;
    from = idx + lit.length;
  }
  if (idx === -1) {
    return {
      ok: false,
      error: `${kind}: literal not found (${JSON.stringify(lit.slice(0, 40))})`,
      candidates: fuzzyCandidatesForLiteral(code, lit),
    };
  }
  const point = kind === 'BEFORE' ? idx : idx + lit.length;
  return {
    ok: true,
    sites: [{
      start: point,
      end: point,
      kind,
      label: `${kind} ${JSON.stringify(lit.slice(0, 40))}`,
    }],
  };
}

function describeFnSpec(spec) {
  if (typeof spec === 'string') return `name=${spec}`;
  if (spec && typeof spec === 'object' && typeof spec.literal === 'string') {
    return `literal=${JSON.stringify(spec.literal.slice(0, 40))}`;
  }
  return '<invalid>';
}

/**
 * Main resolver. Dispatch on at.kind.
 */
export function resolveAt(at, code, _opts = {}) {
  if (!at || typeof at !== 'object') return { ok: false, error: '@At: missing selector object' };
  if (!AT_KINDS.includes(at.kind)) {
    return { ok: false, error: `@At: unknown kind "${at.kind}" (allowed: ${AT_KINDS.join(', ')})` };
  }
  switch (at.kind) {
    case 'HEAD':   return resolveHead(at, code);
    case 'RETURN': return resolveReturn(at, code);
    case 'INVOKE': return resolveInvoke(at, code);
    case 'BEFORE': return resolveBeforeAfter(at, code, 'BEFORE');
    case 'AFTER':  return resolveBeforeAfter(at, code, 'AFTER');
  }
  return { ok: false, error: `@At: unhandled kind ${at.kind}` };
}

// ───────────────────────── Helpers patches can use ─────────────────────────

/**
 * Splice `fragment` immediately after the function's opening brace.
 * Site must come from a HEAD resolution.
 */
export function injectAtHead(code, site, fragment) {
  if (!site || site.kind !== 'HEAD') throw new Error('injectAtHead: site.kind must be HEAD');
  return code.slice(0, site.start) + fragment + code.slice(site.end);
}

/**
 * For BEFORE/AFTER: simple splice at the zero-length site.
 */
export function injectAt(code, site, fragment) {
  if (!site) throw new Error('injectAt: site required');
  return code.slice(0, site.start) + fragment + code.slice(site.end);
}

/**
 * Wrap a return statement.
 *   `return X;`  →  `return (wrapFn(X));`
 *   `return;`    →  `{ voidFn(); return; }`  (when voidFn provided)
 *
 * `transform` is a function `(returnedExpression: string) => string` that
 * produces the *new* expression to return. For void returns, pass a `void`
 * option carrying the side-effect fragment.
 *
 * Sites must be processed in REVERSE order to keep offsets valid; the helper
 * does that automatically when given an array.
 */
export function injectAtReturn(code, siteOrSites, transform, options = {}) {
  const sites = Array.isArray(siteOrSites) ? [...siteOrSites] : [siteOrSites];
  for (const s of sites) {
    if (!s || s.kind !== 'RETURN') throw new Error('injectAtReturn: site.kind must be RETURN');
  }
  // Process in descending order so earlier edits don't shift later sites.
  sites.sort((a, b) => b.start - a.start);
  let out = code;
  for (const site of sites) {
    if (site.void) {
      const fragment = options.voidFragment ?? '';
      // Replace `return;` (or `return}`) with `{ fragment; return; }`.
      const original = out.slice(site.start, site.end);
      const replacement = `{${fragment};${original}}`;
      out = out.slice(0, site.start) + replacement + out.slice(site.end);
    } else {
      const argExpr = out.slice(site.argStart, site.argEnd);
      const wrapped = typeof transform === 'function' ? transform(argExpr) : `(${transform})(${argExpr})`;
      out = out.slice(0, site.argStart) + wrapped + out.slice(site.argEnd);
    }
  }
  return out;
}

/**
 * For INVOKE: wrap `f(args)` → `(before, f(args), after)`.
 * `before` and `after` are expression fragments. Either may be empty.
 */
export function injectAround(code, site, before, after) {
  if (!site || site.kind !== 'INVOKE') throw new Error('injectAround: site.kind must be INVOKE');
  const original = code.slice(site.start, site.end);
  const left = before ? `${before},` : '';
  const right = after ? `,${after}` : '';
  const wrapped = `(${left}${original}${right})`;
  return code.slice(0, site.start) + wrapped + code.slice(site.end);
}

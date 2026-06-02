// runner/resolvers/invoke.mjs
// Resolver for @At INVOKE — call site(s) by name or stable string argument.

import { findFunctionByLiteral, firstOffsetOf } from '../ast-anchor.mjs';
import { findClosingBrace } from '../brace-walker.mjs';

// Per-character classifiers — avoid RegExp.test() in tight scan loops over the
// 16 MB bundle. Identical behavior to the regexes they replace.
//   isIdentChar   ↔ /[A-Za-z0-9_$]/
//   isIdentDotChar↔ /[A-Za-z0-9_$.]/
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

function resolveFunction(spec, code) {
  if (typeof spec === 'string') {
    const needle = `function ${spec}(`;
    const idx = firstOffsetOf(code, needle);
    if (idx === -1) return null;
    let i = idx + needle.length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
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
    const openBrace = code.indexOf('{', fn.start);
    if (openBrace === -1 || openBrace >= fn.end) return null;
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

function describeFnSpec(spec) {
  if (typeof spec === 'string') return `name=${spec}`;
  if (spec && typeof spec === 'object' && typeof spec.literal === 'string') {
    return `literal=${JSON.stringify(spec.literal.slice(0, 40))}`;
  }
  return '<invalid>';
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
 * Given an index `litIdx` known to fall inside a string literal, find the call
 * expression `callee(args)` that immediately encloses it (the literal being a
 * top-level argument). Returns an INVOKE site or null if no such call is found
 * within [scanStart, scanEnd).
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

/**
 * Find all call sites in code[scanStart, scanEnd) whose argument list contains
 * the stable string `literal` as a top-level argument.
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
 * Resolve an INVOKE selector — find call sites for target.call.
 * If target.in is given, scan only within that function.
 *
 * @param {object} target  - at.target from the patch manifest
 * @param {string} code    - full bundle text
 * @param {object} _opts   - reserved
 * @returns {{ ok: true, sites: Array } | { ok: false, error: string }}
 */
export function resolveInvoke(target, code, _opts = {}) {
  const call = target?.call;

  let scanStart = 0;
  let scanEnd = code.length;
  if (target?.in) {
    const fn = resolveFunction(target.in, code);
    if (!fn) return { ok: false, error: `INVOKE: enclosing function not found (${describeFnSpec(target.in)})` };
    scanStart = fn.bodyStart;
    scanEnd = fn.bodyEnd;
  }

  let sites;
  let describeTarget;
  if (typeof call === 'string') {
    sites = findCallsByName(code, call, scanStart, scanEnd);
    describeTarget = `${call}()`;
  } else if (call && typeof call === 'object' && typeof call.literal === 'string') {
    sites = findCallsByLiteralArg(code, call.literal, scanStart, scanEnd);
    describeTarget = `call with literal ${JSON.stringify(call.literal.slice(0, 40))}`;
  } else {
    return { ok: false, error: 'INVOKE: target.call must be a string or { literal }' };
  }

  if (sites.length === 0) {
    return { ok: false, error: `INVOKE: no calls (${describeTarget}) found` };
  }

  if (target.occurrence !== undefined) {
    const n = target.occurrence;
    if (!Number.isInteger(n) || n < 1 || n > sites.length) {
      return { ok: false, error: `INVOKE: occurrence ${n} out of range (found ${sites.length} call(s))` };
    }
    return { ok: true, sites: [sites[n - 1]] };
  }
  return { ok: true, sites };
}

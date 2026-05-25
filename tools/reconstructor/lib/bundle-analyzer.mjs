/**
 * Phase 2: Analyze a minified cli.js bundle.
 *
 * Extracts string literals and their positions using acorn's tokenizer
 * for speed (no full AST needed). Identifies module boundary patterns.
 */

import fs from 'node:fs';
import * as acorn from 'acorn';
import { log, verbose, elapsed } from './utils.mjs';

/**
 * @typedef {Object} StringLiteral
 * @property {string}  value
 * @property {number}  line    - 1-based
 * @property {number}  column  - 0-based
 * @property {number}  start   - byte offset in source
 * @property {number}  end     - byte offset end
 */

/**
 * @typedef {Object} ModuleBoundary
 * @property {'factory'|'lazy'} type
 * @property {string}  wrapperName    - the single-char function name (e.g. 'm' or 'y')
 * @property {string}  varName        - the assigned variable name
 * @property {number}  start          - byte offset of the var declaration
 * @property {number}  end            - byte offset of closing ')' of the wrapper call
 * @property {number}  bodyStart      - byte offset of the arrow function body '{'
 * @property {number}  bodyEnd        - byte offset of the closing '}'
 * @property {number}  line           - 1-based start line
 * @property {number}  endLine        - 1-based end line
 */

/**
 * @typedef {Object} GapChunk
 * @property {'preamble'|'interstitial'|'entry'} type
 * @property {number}  start          - byte offset start
 * @property {number}  end            - byte offset end
 * @property {number}  line           - 1-based start line
 * @property {number}  endLine        - 1-based end line
 */

/**
 * @typedef {Object} BundleAnalysis
 * @property {string}          code       - raw bundle source
 * @property {StringLiteral[]} strings    - all string literals found
 * @property {ModuleBoundary[]} modules   - detected module boundaries
 * @property {GapChunk[]}      gaps       - code ranges not covered by any module
 * @property {number[]}        lineStarts - byte offset of each line start (0-indexed by line-1)
 */

/**
 * Analyze a bundle file.
 * @param {string} bundlePath
 * @returns {BundleAnalysis}
 */
export function analyzeBundle(bundlePath) {
  const t0 = Date.now();
  log('analyzer', `Analyzing ${bundlePath}...`);

  const code = fs.readFileSync(bundlePath, 'utf-8');
  verbose('analyzer', `Read ${(code.length / 1e6).toFixed(1)}MB in ${elapsed(t0)}`);

  // Build line offset table
  const lineStarts = buildLineStarts(code);

  // Extract strings using acorn tokenizer (much faster than full AST)
  const t1 = Date.now();
  const strings = extractStrings(code);
  verbose('analyzer', `Extracted ${strings.length} string literals in ${elapsed(t1)}`);

  // Detect module boundaries using regex (reliable for esbuild output)
  const t2 = Date.now();
  const modules = detectModuleBoundaries(code, lineStarts);
  log('analyzer', `Detected ${modules.length} module boundaries in ${elapsed(t2)}`);

  // Detect gaps: code ranges not covered by any module wrapper
  const gaps = detectGaps(code, modules, lineStarts);
  verbose('analyzer', `Detected ${gaps.length} gap chunks (${gaps.filter(g => g.type === 'preamble').length} preamble, ${gaps.filter(g => g.type === 'interstitial').length} interstitial, ${gaps.filter(g => g.type === 'entry').length} entry)`);

  log('analyzer', `Total analysis time: ${elapsed(t0)}`);

  return { code, strings, modules, gaps, lineStarts };
}

/**
 * Build a table mapping line number (0-based) to byte offset of line start.
 */
function buildLineStarts(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) { // '\n'
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Get 1-based line number for a byte offset.
 */
export function offsetToLine(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo; // 1-based
}

/**
 * Extract all string literals from minified JS using acorn's tokenizer.
 */
function extractStrings(code) {
  const strings = [];

  try {
    for (const token of acorn.tokenizer(code, {
      ecmaVersion: 2024,
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
    })) {
      if (token.type.label === 'string' && typeof token.value === 'string') {
        strings.push({
          value: token.value,
          line: token.loc.start.line,
          column: token.loc.start.column,
          start: token.start,
          end: token.end,
        });
      }
      // Also capture template literal quasis
      if (token.type.label === 'template' && typeof token.value === 'string') {
        strings.push({
          value: token.value,
          line: token.loc.start.line,
          column: token.loc.start.column,
          start: token.start,
          end: token.end,
        });
      }
    }
  } catch (e) {
    log('analyzer', `Tokenizer error at offset ${e.pos}: ${e.message}`);
    // Fall back to regex extraction if tokenizer fails
    return extractStringsRegex(code);
  }

  return strings;
}

/**
 * Fallback regex-based string extraction.
 * Handles double-quoted and single-quoted strings with escapes.
 */
function extractStringsRegex(code) {
  console.warn('[analyzer] WARNING: Using regex fallback for string extraction — template literals will be missed');
  const strings = [];
  // Match "..." and '...' with escape handling
  const re = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let match;

  // Pre-build line starts for position computation
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  while ((match = re.exec(code)) !== null) {
    const raw = match[0];
    const value = raw.slice(1, -1); // strip quotes
    if (value.length === 0) continue;

    // Compute real line/column using binary search on lineStarts
    const offset = match.index;
    let lo = 0, hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    const line = lo; // 1-based
    const column = offset - lineStarts[lo - 1]; // 0-based

    strings.push({
      value,
      line,
      column,
      start: offset,
      end: offset + raw.length,
    });
  }

  return strings;
}

/**
 * Detect module boundaries in esbuild output.
 *
 * esbuild produces two patterns:
 * 1. Factory: var NAME = WRAPPER((exports, module) => { ... });
 *    where WRAPPER is a short identifier (e.g. 'm', 'p')
 * 2. Lazy init: var NAME = WRAPPER(() => { ... });
 *    where WRAPPER is a short identifier (e.g. 'y', 'E')
 *
 * We detect these by finding the wrapper function calls and then
 * brace-matching to find the extent of each module.
 */
function detectModuleBoundaries(code, lineStarts) {
  const modules = [];

  // Detect the wrapper function names by looking at the most common patterns.
  // In v2.1.88: m((exports,module)=>{...}) and y(()=>{...})
  // In v2.1.89: p((exports,module)=>{...}) and E(()=>{...})
  //
  // Strategy: find "var/let/const X=Y((" patterns where Y is 1-3 chars
  const wrapperRe = /(?:var|let|const)\s+([A-Za-z$_][\w$]*)=([A-Za-z$_]{1,3})\((?:\(|(?=[A-Za-z$_]))/g;
  let match;

  // First pass: count occurrences of each wrapper name to identify the real ones
  const wrapperCounts = new Map();
  while ((match = wrapperRe.exec(code)) !== null) {
    const wrapper = match[2];
    wrapperCounts.set(wrapper, (wrapperCounts.get(wrapper) || 0) + 1);
  }

  // The factory wrapper appears ~2000 times, lazy wrapper ~2500 times.
  // Keep ALL wrappers with count > 100 (don't hardcode to 2 — esbuild may
  // use 3+ patterns, e.g. __commonJS, __esm, JSON modules).
  const topWrappers = [...wrapperCounts.entries()]
    .filter(([, count]) => count > 100)
    .sort((a, b) => b[1] - a[1]);

  if (topWrappers.length === 0) {
    log('analyzer', 'Warning: No module wrapper patterns detected');
    return modules;
  }

  verbose('analyzer', `Detected wrappers: ${topWrappers.map(([n, c]) => `${n}(${c})`).join(', ')}`);

  // Identify which is factory (has exports,module params) vs lazy (no params)
  // by checking the first occurrence of each
  const wrapperTypes = new Map();
  for (const [wrapperName] of topWrappers) {
    const testRe = new RegExp(`(?:var|let|const)\\s+\\w+=` + escapeRegex(wrapperName) + `\\((?:\\(([^)]*?)\\)|([A-Za-z$_][\\w$]*))\\s*=>\\s*\\{`, 'g');
    const testMatch = testRe.exec(code);
    if (testMatch) {
      const params = (testMatch[1] ?? testMatch[2] ?? '').trim();
      wrapperTypes.set(wrapperName, params.length > 0 ? 'factory' : 'lazy');
    }
  }

  // Second pass: extract all module boundaries
  wrapperRe.lastIndex = 0;
  while ((match = wrapperRe.exec(code)) !== null) {
    const varName = match[1];
    const wrapperName = match[2];

    if (!wrapperTypes.has(wrapperName)) continue;

    const type = wrapperTypes.get(wrapperName);
    const varStart = match.index;

    // Find the opening '{' of the arrow body after the '=>'
    // Search for '=>' followed closely by '{' to avoid matching nested arrows
    const arrowSearchStart = match.index + match[0].length;
    let arrowIdx = -1;
    let braceStart = -1;
    let searchFrom = arrowSearchStart;
    // Bound the search: the arrow + opening brace should be within ~200 chars
    // of the match (covers long param lists like (exports, module, __webpack_require__))
    const searchLimit = Math.min(arrowSearchStart + 200, code.length);
    while (searchFrom < searchLimit) {
      const candidate = code.indexOf('=>', searchFrom);
      if (candidate === -1 || candidate >= searchLimit) break;
      // Check if '{' follows within a few chars (allowing whitespace)
      const afterArrow = candidate + 2;
      let braceSearch = afterArrow;
      while (braceSearch < afterArrow + 10 && braceSearch < code.length) {
        const ch = code.charCodeAt(braceSearch);
        if (ch === 123) { // '{'
          arrowIdx = candidate;
          braceStart = braceSearch;
          break;
        }
        if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) break; // non-whitespace, non-brace
        braceSearch++;
      }
      if (arrowIdx !== -1) break;
      searchFrom = candidate + 2;
    }
    if (arrowIdx === -1 || braceStart === -1) continue;

    // Brace-match to find the end. We need to handle nested braces,
    // strings, template literals, and regex.
    const braceEnd = findMatchingBrace(code, braceStart);
    if (braceEnd === -1) continue;

    // The module boundary ends at the closing ');' after the brace
    // Pattern: })); or })
    let wrapperEnd = braceEnd + 1;
    // Skip closing parens
    while (wrapperEnd < code.length && code[wrapperEnd] === ')') wrapperEnd++;
    if (code[wrapperEnd] === ';') wrapperEnd++;

    modules.push({
      type,
      wrapperName,
      varName,
      start: varStart,
      end: wrapperEnd,
      bodyStart: braceStart,
      bodyEnd: braceEnd,
      line: offsetToLine(lineStarts, varStart),
      endLine: offsetToLine(lineStarts, wrapperEnd),
    });
  }

  // Sort by position
  modules.sort((a, b) => a.start - b.start);

  verbose('analyzer', `  Factories: ${modules.filter(m => m.type === 'factory').length}`);
  verbose('analyzer', `  Lazy inits: ${modules.filter(m => m.type === 'lazy').length}`);

  return modules;
}

/**
 * Detect code ranges ("gaps") not covered by any module wrapper.
 *
 * Classifies each gap as:
 * - 'preamble'     — code before the first module (runtime helpers like __require, __commonJS defs)
 * - 'interstitial' — code between two modules (rare, but possible)
 * - 'entry'        — code after the last module (entry point / bootstrap)
 *
 * Only non-whitespace gaps are returned.
 *
 * @param {string} code
 * @param {ModuleBoundary[]} modules  - must be sorted by start
 * @param {number[]} lineStarts
 * @returns {GapChunk[]}
 */
function detectGaps(code, modules, lineStarts) {
  const gaps = [];
  let prevEnd = 0;
  let pastFirstModule = false;

  // Modules are already sorted by start from detectModuleBoundaries
  for (const mod of modules) {
    if (mod.start > prevEnd) {
      const gapCode = code.slice(prevEnd, mod.start);
      if (gapCode.trim().length > 0) {
        // Before the first module → preamble; between modules → interstitial
        const type = !pastFirstModule ? 'preamble' : 'interstitial';
        gaps.push({
          type,
          start: prevEnd,
          end: mod.start,
          line: offsetToLine(lineStarts, prevEnd),
          endLine: offsetToLine(lineStarts, mod.start),
        });
      }
    }
    pastFirstModule = true;
    prevEnd = mod.end;
  }

  // Code after the last module → entry point / bootstrap
  if (prevEnd < code.length) {
    const tailCode = code.slice(prevEnd);
    if (tailCode.trim().length > 0) {
      gaps.push({
        type: 'entry',
        start: prevEnd,
        end: code.length,
        line: offsetToLine(lineStarts, prevEnd),
        endLine: offsetToLine(lineStarts, code.length - 1),
      });
    }
  }

  return gaps;
}

/**
 * Find the matching closing brace for an opening '{' at position `start`.
 * Handles nested braces, string literals, template literals, regex, and comments.
 */
function findMatchingBrace(code, start) {
  let depth = 0;
  let i = start;
  const len = code.length;

  while (i < len) {
    const ch = code.charCodeAt(i);

    // String literals
    if (ch === 34 || ch === 39) { // " or '
      i = skipString(code, i);
      continue;
    }

    // Template literal
    if (ch === 96) { // `
      i = skipTemplateLiteral(code, i);
      continue;
    }

    // Forward slash: could be comment (//, /*) or regex literal
    if (ch === 47 && i + 1 < len) {
      const next = code.charCodeAt(i + 1);
      if (next === 47) { // //
        i = code.indexOf('\n', i + 2);
        if (i === -1) return -1;
        i++;
        continue;
      }
      if (next === 42) { // /*
        i = code.indexOf('*/', i + 2);
        if (i === -1) return -1;
        i += 2;
        continue;
      }
      // Check for regex literal: '/' that is NOT division.
      // Division follows a value-producing token (identifier char, digit,
      // closing bracket/paren, ++, --).  Regex follows everything else
      // (operators, opening paren/bracket, comma, semicolon, keywords, etc.)
      if (isRegexContext(code, i)) {
        i = skipRegexLiteral(code, i);
        continue;
      }
    }

    if (ch === 123) { // {
      depth++;
    } else if (ch === 125) { // }
      depth--;
      if (depth === 0) return i;
    }

    i++;
  }

  return -1;
}

function skipString(code, start) {
  const quote = code.charCodeAt(start);
  let i = start + 1;
  while (i < code.length) {
    const ch = code.charCodeAt(i);
    if (ch === 92) { i += 2; continue; } // backslash escape
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplateLiteral(code, start) {
  let i = start + 1;
  while (i < code.length) {
    const ch = code.charCodeAt(i);
    if (ch === 92) { i += 2; continue; } // backslash escape
    if (ch === 36 && i + 1 < code.length && code.charCodeAt(i + 1) === 123) { // ${
      i += 2;
      // Skip the interpolation expression, handling nested braces and template literals
      i = skipInterpolation(code, i);
      continue;
    }
    if (ch === 96) return i + 1; // closing `
    i++;
  }
  return i;
}

/**
 * Skip a template literal interpolation expression starting after '${'.
 * Handles nested braces, strings, and nested template literals recursively.
 * Returns position after the closing '}'.
 */
function skipInterpolation(code, start) {
  let i = start;
  let braceDepth = 1;
  while (i < code.length && braceDepth > 0) {
    const ch = code.charCodeAt(i);
    if (ch === 34 || ch === 39) { // " or ' — skip string
      i = skipString(code, i);
      continue;
    }
    if (ch === 96) { // nested template literal
      i = skipTemplateLiteral(code, i);
      continue;
    }
    if (ch === 123) { // {
      braceDepth++;
    } else if (ch === 125) { // }
      braceDepth--;
      if (braceDepth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Determine if a '/' at position `pos` starts a regex literal (not division).
 *
 * Division follows value-producing tokens: identifiers, digits, `)`, `]`, `++`, `--`.
 * A regex follows everything else: operators, `(`, `[`, `{`, `,`, `;`, `!`, `~`,
 * keywords like return/typeof/void/in/instanceof/etc., or start-of-input.
 */
// Keywords that precede regex literals (not division).
// Hoisted to module scope to avoid re-creating the Set on every call —
// isRegexContext is called inside findMatchingBrace which iterates through
// potentially millions of characters across ~4500 module boundaries.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'void', 'delete', 'throw', 'new', 'in',
  'instanceof', 'case', 'yield', 'await', 'else', 'do',
]);

function isRegexContext(code, pos) {
  // Walk backwards past any whitespace
  let j = pos - 1;
  while (j >= 0 && (code.charCodeAt(j) === 32 || code.charCodeAt(j) === 9 ||
                     code.charCodeAt(j) === 10 || code.charCodeAt(j) === 13)) {
    j--;
  }
  if (j < 0) return true; // start of relevant code scope — regex

  const prevCh = code.charCodeAt(j);

  // After ')' or ']' it's typically division (e.g., arr[0] / 2, fn() / 2).
  // Exception: if/for/while(...)/ would be regex, but those are extremely rare
  // in minified esbuild output; treating ')' as division is the safer bet.
  if (prevCh === 41 || prevCh === 93) return false; // ) or ]

  // After an identifier char or digit → division
  // Covers: variable names, numbers, true, false, null, this, etc.
  if ((prevCh >= 48 && prevCh <= 57) ||   // 0-9
      (prevCh >= 65 && prevCh <= 90) ||   // A-Z
      (prevCh >= 97 && prevCh <= 122) ||  // a-z
      prevCh === 36 || prevCh === 95) {   // $ or _
    // But we need to check for keywords that precede regex: return, typeof,
    // void, delete, throw, new, in, instanceof, case, yield, await
    // Extract the preceding word
    let wordEnd = j + 1;
    let wordStart = j;
    while (wordStart > 0 && (
      (code.charCodeAt(wordStart - 1) >= 65 && code.charCodeAt(wordStart - 1) <= 90) ||
      (code.charCodeAt(wordStart - 1) >= 97 && code.charCodeAt(wordStart - 1) <= 122) ||
      (code.charCodeAt(wordStart - 1) >= 48 && code.charCodeAt(wordStart - 1) <= 57) ||
      code.charCodeAt(wordStart - 1) === 36 || code.charCodeAt(wordStart - 1) === 95
    )) {
      wordStart--;
    }
    const word = code.slice(wordStart, wordEnd);
    if (REGEX_KEYWORDS.has(word)) return true;
    return false; // identifier or number → division
  }

  // After '++' or '--' → division (post-increment result)
  if ((prevCh === 43 && j > 0 && code.charCodeAt(j - 1) === 43) ||  // ++
      (prevCh === 45 && j > 0 && code.charCodeAt(j - 1) === 45)) {  // --
    return false;
  }

  // Everything else (operators, '{', '(', '[', ',', ';', '!', '~', ':', '?', etc.)
  // → regex context
  return true;
}

/**
 * Skip a regex literal starting at position `start` (which points to the opening '/').
 * Returns the position after the regex (past any trailing flags like /gi).
 */
function skipRegexLiteral(code, start) {
  let i = start + 1;
  const len = code.length;
  while (i < len) {
    const ch = code.charCodeAt(i);
    if (ch === 92) { // backslash — skip next char
      i += 2;
      continue;
    }
    if (ch === 91) { // '[' character class — skip until ']'
      i++;
      while (i < len) {
        const cc = code.charCodeAt(i);
        if (cc === 92) { i += 2; continue; } // escape in char class
        if (cc === 93) { i++; break; }        // end of char class
        i++;
      }
      continue;
    }
    if (ch === 47) { // closing '/'
      i++;
      // Skip flags (g, i, m, s, u, v, y, d)
      while (i < len && (
        (code.charCodeAt(i) >= 97 && code.charCodeAt(i) <= 122) // a-z
      )) {
        i++;
      }
      return i;
    }
    if (ch === 10 || ch === 13) {
      // Newline inside regex → not actually a regex (shouldn't happen in valid JS)
      return start + 1; // bail: treat '/' as division
    }
    i++;
  }
  return i;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

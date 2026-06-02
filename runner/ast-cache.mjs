// runner/ast-cache.mjs
//
// Tiny AST cache shared by ast-anchor.mjs, patch-kinds.mjs, and at-selector.mjs.
//
// Without this, the same windowed function text is re-parsed by Acorn up to
// four times per declarative patch (literal probe → locateTarget → postfix
// rewrite → resolveAt collectReturns). For a 60-line minified function the
// parse is cheap individually but multiplied across 30+ patches it dominates
// per-bundle apply time.
//
// Keying (CONTENT-ADDRESSED):
//   The previous design keyed by the bundle `code` string's IDENTITY and
//   mapped `${start}:${end}` → AST within it. That only ever hit WITHIN a
//   single patch: every transform produces a brand-new bundle string, so the
//   `cachedCode !== code` check tripped on the very next apply and the whole
//   Map was discarded. Across ~26 declarative patches over a 15MB bundle that
//   meant re-windowing and re-parsing the same unchanged function text from
//   scratch on every patch — only intra-patch reuse survived.
//
//   We now key by the windowed function TEXT itself (the exact `(${fnText})`
//   string we hand to Acorn). Most windows are byte-identical between patches
//   — a patch only mutates the one function it touches — so a text-keyed entry
//   survives across applies and the cache actually hits. Offsets (start/end)
//   no longer participate in the key: identical text always parses to the same
//   Program node regardless of where it sits in the bundle.
//
// Bounding:
//   A content-addressed cache would grow with every distinct window seen over
//   a big build, so we cap it with a simple insertion-ordered LRU (evict the
//   oldest entry once we exceed MAX_CACHED_ASTS). A cache miss costs one Acorn
//   parse; bounding it trades a rare re-parse for a hard memory ceiling.

import * as acorn from 'acorn';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DISK_CACHE_DIR = join(__dirname, '..', '.cc', 'cache');

function diskCacheKey(fnText) {
  return 'ast-' + createHash('sha256').update(fnText).digest('hex').slice(0, 16);
}

function readDiskCache(fnText) {
  if (process.env.CCPATCH_NO_DISK_CACHE) return null;
  const path = join(DISK_CACHE_DIR, diskCacheKey(fnText) + '.json');
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    // verify key matches to guard against hash collisions
    if (entry.key !== diskCacheKey(fnText)) return null;
    return entry.ast;
  } catch { return null; }
}

function writeDiskCache(fnText, ast) {
  if (process.env.CCPATCH_NO_DISK_CACHE) return;
  try {
    mkdirSync(DISK_CACHE_DIR, { recursive: true });
    const path = join(DISK_CACHE_DIR, diskCacheKey(fnText) + '.json');
    writeFileSync(path, JSON.stringify({ key: diskCacheKey(fnText), ast }));
  } catch { /* disk cache is opportunistic -- ignore write errors */ }
}

const MAX_CACHED_ASTS = 256;
// Map<wrappedText, AST>, insertion-ordered → oldest key is least-recently-used.
let astCache = new Map();

/**
 * Get (or compute and cache) the Acorn AST for the function text at
 * code.slice(start, end). The text MUST be `(${fnText})` parseable as a
 * top-level expression — every caller in ccpatch wraps that way already.
 *
 * The cache is content-addressed: identical window text returns the same
 * Program node regardless of `code`/`start`/`end`, so entries survive across
 * patch applies (which always hand us a freshly-allocated bundle string).
 *
 * @param {string} code     - Bundle source. Only used to slice the window.
 * @param {number} start    - Start offset of the function text in `code`.
 * @param {number} end      - End offset (exclusive) of the function text.
 * @param {string} [fnText] - Optional pre-sliced text; defaults to code.slice.
 * @returns {object} Acorn Program node from parsing `(${fnText})`.
 */
export function getAst(code, start, end, fnText) {
  const text = fnText !== undefined ? fnText : code.slice(start, end);
  const wrapped = `(${text})`;

  const cached = astCache.get(wrapped);
  if (cached !== undefined) {
    // Touch: mark most-recently-used by re-inserting at the end of the order.
    astCache.delete(wrapped);
    astCache.set(wrapped, cached);
    return cached;
  }

  // Check disk cache before invoking Acorn (cross-process reuse).
  const diskHit = readDiskCache(wrapped);
  if (diskHit !== null) {
    astCache.set(wrapped, diskHit);
    if (astCache.size > MAX_CACHED_ASTS) {
      const oldestKey = astCache.keys().next().value;
      astCache.delete(oldestKey);
    }
    return diskHit;
  }

  const ast = acorn.parse(wrapped, {
    ecmaVersion: 'latest',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: true,
  });

  astCache.set(wrapped, ast);
  if (astCache.size > MAX_CACHED_ASTS) {
    // Evict the least-recently-used (oldest insertion) entry.
    const oldestKey = astCache.keys().next().value;
    astCache.delete(oldestKey);
  }
  writeDiskCache(wrapped, ast);
  return ast;
}

/**
 * Clear the AST cache. Useful for test isolation. Since the cache is now keyed
 * by window text (not bundle identity), stale entries are never returned for
 * mutated source — identical text is, by definition, the same function — so
 * this is only needed to reclaim memory or to get a clean slate in tests.
 */
export function resetAstCache() {
  astCache = new Map();
}

/**
 * Remove all disk-cached AST entries. Useful for test isolation or cache invalidation.
 */
export function resetDiskCache() {
  if (process.env.CCPATCH_NO_DISK_CACHE) return;
  try {
    for (const f of readdirSync(DISK_CACHE_DIR).filter(f => f.startsWith('ast-')))
      unlinkSync(join(DISK_CACHE_DIR, f));
  } catch {}
}

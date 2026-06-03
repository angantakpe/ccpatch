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
import { readFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './paths.mjs';

const MAX_CACHED_ASTS = 256;

// ---------------------------------------------------------------------------
// Disk cache — persists parsed ASTs across process restarts.
// ---------------------------------------------------------------------------

const DISK_CACHE_DIR = join(PROJECT_ROOT, '.ast-cache');
const MAX_DISK_ENTRIES = 512;

/** 128-bit (32 hex chars) content-addressed key for the given function text. */
function diskCacheKey(fnText) {
  return createHash('sha256').update(fnText).digest('hex').slice(0, 32);
}

function readDiskCache(key) {
  try {
    const data = readFileSync(join(DISK_CACHE_DIR, `ast-${key}.json`), 'utf8');
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

let _writeCount = 0;

function writeDiskCache(key, ast) {
  try {
    mkdirSync(DISK_CACHE_DIR, { recursive: true });
    fsp.writeFile(join(DISK_CACHE_DIR, `ast-${key}.json`), JSON.stringify(ast)).catch(() => {});
  } catch {
    return; // disk cache is opportunistic; write failure must never throw
  }
  _writeCount++;
  if (_writeCount % 16 !== 0) return;
  // Prune to MAX_DISK_ENTRIES, leaving a buffer of 16 so we don't re-prune every write.
  try {
    const entries = readdirSync(DISK_CACHE_DIR)
      .filter(f => /^ast-[0-9a-f]+\.json$/.test(f));
    if (entries.length > MAX_DISK_ENTRIES) {
      const withMtime = entries.map(f => {
        const fp = join(DISK_CACHE_DIR, f);
        try {
          return { f: fp, mtime: statSync(fp).mtimeMs };
        } catch {
          return { f: fp, mtime: 0 };
        }
      });
      // Sort oldest first.
      withMtime.sort((a, b) => a.mtime - b.mtime);
      const deleteCount = entries.length - (MAX_DISK_ENTRIES - 16);
      for (let i = 0; i < deleteCount; i++) {
        try { unlinkSync(withMtime[i].f); } catch { /* ignore */ }
      }
    }
  } catch {
    // Pruning failure must never propagate.
  }
}
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

  // Compute the cache key once and pass it to both read and write.
  const key = diskCacheKey(text);
  const diskHit = readDiskCache(key);
  if (diskHit !== undefined) {
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
  writeDiskCache(key, ast);
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

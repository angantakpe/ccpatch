/**
 * Variable-name-agnostic code normalization.
 *
 * Replaces all identifiers with positional placeholders ($0, $1, $2...)
 * based on first-occurrence order. Keeps operators, keywords, strings,
 * and numbers intact. The result is comparable across minifier versions.
 */

import * as acorn from 'acorn';
// JavaScript keywords that should NOT be replaced
const KEYWORDS = new Set([
  'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
  'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
  'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
  'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
  'protected', 'public', 'static', 'yield', 'async', 'await', 'of',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  // Common globals that are stable
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'RegExp', 'Date', 'Math',
  'JSON', 'console', 'process', 'Buffer', 'require', 'module', 'exports',
  'globalThis', 'global', 'window', 'document', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'fetch', 'Headers', 'Request', 'Response', 'FormData',
  'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream',
  'EventTarget', 'Event', 'CustomEvent', 'Proxy', 'Reflect',
  'Int32Array', 'Uint8Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  'SharedArrayBuffer', 'Atomics', 'WebAssembly',
]);

/**
 * Normalize a code string by replacing identifiers with positional placeholders.
 *
 * @param {string} code
 * @returns {{ normalized: string, identMap: Map<string, string> }}
 *   normalized: the code with identifiers replaced
 *   identMap: original name → placeholder mapping
 */
export function normalizeCode(code) {
  const identMap = new Map();
  let counter = 0;
  const parts = [];
  let lastEnd = 0;

  try {
    for (const token of acorn.tokenizer(code, {
      ecmaVersion: 2024,
      sourceType: 'module',
      allowHashBang: true,
    })) {
      // Only replace identifier tokens (name tokens)
      if (token.type.label === 'name') {
        const name = token.value;
        if (KEYWORDS.has(name)) {
          // Keep keywords as-is
          parts.push(code.slice(lastEnd, token.end));
          lastEnd = token.end;
          continue;
        }

        // Replace with placeholder
        let placeholder = identMap.get(name);
        if (placeholder === undefined) {
          placeholder = `$${counter++}`;
          identMap.set(name, placeholder);
        }

        parts.push(code.slice(lastEnd, token.start));
        parts.push(placeholder);
        lastEnd = token.end;
      }
    }
  } catch (e) {
    // If tokenization fails, mark as failed so callers can handle degraded accuracy
    console.warn(`[normalizer] WARNING: Tokenization failed for ${code.length}-char code block: ${e.message}`);
    return { normalized: code, identMap, failed: true };
  }

  parts.push(code.slice(lastEnd));
  return { normalized: parts.join(''), identMap, failed: false };
}

/**
 * Compute normalized similarity between two code strings.
 * Returns 0.0 to 1.0.
 *
 * Uses a fast trigram-based comparison on the normalized forms.
 */
export function normalizedSimilarity(codeA, codeB) {
  const resultA = normalizeCode(codeA);
  const resultB = normalizeCode(codeB);

  // If either normalization failed, trigram similarity on raw minified code
  // would produce inflated scores due to shared minification artifacts.
  // Return 0 to prevent false matches.
  if (resultA.failed || resultB.failed) return 0;

  const normA = resultA.normalized;
  const normB = resultB.normalized;

  if (normA === normB) return 1.0;
  if (normA.length === 0 || normB.length === 0) return 0;

  // For very short code blocks, trigram similarity is unreliable
  // (too few trigrams → high false-match rate). Use exact match only.
  if (normA.length < 30 && normB.length < 30) return 0;

  return trigramSimilarity(normA, normB);
}

/**
 * Trigram (3-character substring) based similarity.
 * Jaccard on the set of trigrams. Fast approximation of edit distance ratio.
 */
function trigramSimilarity(a, b) {
  const triA = buildTrigrams(a);
  const triB = buildTrigrams(b);
  return trigramJaccard(triA, triB);
}

function trigramJaccard(triA, triB) {
  let intersection = 0;
  const [smaller, larger] = triA.size <= triB.size ? [triA, triB] : [triB, triA];

  for (const tri of smaller) {
    if (larger.has(tri)) intersection++;
  }

  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildTrigrams(str) {
  const set = new Set();
  for (let i = 0; i <= str.length - 3; i++) {
    set.add(str.slice(i, i + 3));
  }
  return set;
}

/**
 * Per-chunk normalize/trigram cache.
 *
 * `normalizedSimilarity` re-tokenizes both inputs on every call. The aligner
 * invokes it inside O(B×T) loops (positionalMatching, structuralFallback,
 * classifyAndAttribute), so the same chunk's code gets normalized many times.
 * Memoize once per chunk and reuse.
 *
 * @param {{code: string}[]} chunks
 */
export function createNormCache(chunks) {
  const n = chunks.length;
  const norm = new Array(n);     // string | null   (null = tokenization failed)
  const tri = new Array(n);      // Set<string> | null | undefined
  return {
    size: n,
    getNormalized(id) {
      let v = norm[id];
      if (v !== undefined) return v;
      const r = normalizeCode(chunks[id].code);
      v = r.failed ? null : r.normalized;
      norm[id] = v;
      return v;
    },
    getTrigrams(id) {
      let t = tri[id];
      if (t !== undefined) return t;
      const v = this.getNormalized(id);
      if (v === null || v.length < 3) { tri[id] = null; return null; }
      t = buildTrigrams(v);
      tri[id] = t;
      return t;
    },
  };
}

/**
 * Compute normalized similarity between two chunks using cached forms.
 * Equivalent to `normalizedSimilarity(baseChunks[bId].code, targetChunks[tId].code)`
 * but reuses memoized normalize + trigram results across calls.
 */
export function cachedNormalizedSimilarity(baseCache, bId, targetCache, tId) {
  const a = baseCache.getNormalized(bId);
  const b = targetCache.getNormalized(tId);
  if (a === null || b === null) return 0;       // tokenization failed → no false matches
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length < 30 && b.length < 30) return 0; // too-short heuristic mirrors normalizedSimilarity
  const triA = baseCache.getTrigrams(bId);
  const triB = targetCache.getTrigrams(tId);
  if (!triA || !triB) return 0;
  return trigramJaccard(triA, triB);
}

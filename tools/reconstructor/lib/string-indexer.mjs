/**
 * Build string-based indexes for module alignment.
 *
 * Two indexes:
 * 1. Forward: string value → list of (chunkId, position) entries
 * 2. Unique anchors: strings appearing exactly once in each bundle
 */

import { verbose, elapsed } from './utils.mjs';

/**
 * @typedef {Object} StringIndex
 * @property {Map<string, {chunkId: number, start: number}[]>} forward
 *   - For each string value, all chunks containing it
 * @property {Map<string, number>} uniqueToChunk
 *   - Strings that appear in exactly one chunk → that chunk's id
 * @property {number} totalStrings
 */

/**
 * Build a string index from segmented chunks.
 * @param {import('./module-segmenter.mjs').ModuleChunk[]} chunks
 * @returns {StringIndex}
 */
export function buildStringIndex(chunks) {
  const t0 = Date.now();
  const forward = new Map();
  let totalStrings = 0;

  for (const chunk of chunks) {
    for (const str of chunk.strings) {
      totalStrings++;
      let entries = forward.get(str.value);
      if (!entries) {
        entries = [];
        forward.set(str.value, entries);
      }
      entries.push({ chunkId: chunk.id, start: str.start });
    }
  }

  // Build unique-to-chunk map: strings appearing in exactly one chunk
  const uniqueToChunk = new Map();
  for (const [value, entries] of forward) {
    // Check if all entries point to the same chunk
    const chunkIds = new Set(entries.map(e => e.chunkId));
    if (chunkIds.size === 1) {
      uniqueToChunk.set(value, entries[0].chunkId);
    }
  }

  verbose('string-idx', `Indexed ${totalStrings} strings (${forward.size} unique values, ${uniqueToChunk.size} unique-to-chunk) in ${elapsed(t0)}`);

  return { forward, uniqueToChunk, totalStrings };
}

/**
 * Find anchor strings: values that appear in exactly one chunk in BOTH indexes.
 * These are guaranteed 1:1 module matches.
 *
 * @param {StringIndex} baseIndex
 * @param {StringIndex} targetIndex
 * @returns {Map<string, {baseChunkId: number, targetChunkId: number}>}
 */
export function findAnchorStrings(baseIndex, targetIndex) {
  const t0 = Date.now();
  const anchors = new Map();

  // Common short strings that can be unique-to-chunk by coincidence
  const UNRELIABLE_ANCHORS = new Set([
    'yes', 'no', 'ok', 'get', 'set', 'put', 'key', 'val', 'add', 'del',
    'run', 'end', 'map', 'pop', 'raw', 'log', 'new', 'old', 'all', 'any',
    'err', 'msg', 'str', 'num', 'len', 'max', 'min', 'sum', 'avg', 'cnt',
    'src', 'dst', 'tmp', 'buf', 'idx', 'pos', 'col', 'row', 'tag', 'ref',
    'url', 'uri', 'api', 'cli', 'env', 'opt', 'arg', 'cmd', 'cwd', 'pid',
    'uid', 'gid', 'dir', 'ext', 'mod', 'pkg', 'lib', 'bin', 'out', 'ret',
  ]);

  for (const [value, baseChunkId] of baseIndex.uniqueToChunk) {
    // Skip short strings — they are unreliable as anchors
    if (value.length <= 3) continue;
    // Skip known-unreliable short strings
    if (value.length <= 5 && UNRELIABLE_ANCHORS.has(value.toLowerCase())) continue;
    const targetChunkId = targetIndex.uniqueToChunk.get(value);
    if (targetChunkId !== undefined) {
      anchors.set(value, { baseChunkId, targetChunkId });
    }
  }

  verbose('string-idx', `Found ${anchors.size} anchor strings in ${elapsed(t0)}`);
  return anchors;
}

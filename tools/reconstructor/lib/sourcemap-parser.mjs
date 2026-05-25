/**
 * Phase 1: Parse a v3 source map and build a bidirectional index.
 *
 * Input:  path to cli.js.map
 * Output: SourceMapIndex with per-source-file info and gen-position lookup
 */

import fs from 'node:fs';
import { decodeMappings } from './vlq.mjs';
import { log, verbose, elapsed } from './utils.mjs';

/**
 * @typedef {Object} SourceMapping
 * @property {number} genLine      - 0-based line in generated file
 * @property {number} genColumn    - 0-based column in generated file
 * @property {number} sourceIndex  - index into sources array
 * @property {number} sourceLine   - 0-based line in original source
 * @property {number} sourceColumn - 0-based column in original source
 */

/**
 * @typedef {Object} SourceFileInfo
 * @property {number} index
 * @property {string} path
 * @property {string} content
 * @property {SourceMapping[]} mappings
 */

/**
 * @typedef {Object} SourceMapIndex
 * @property {SourceFileInfo[]} sources
 * @property {SourceMapping[]} allMappings       - sorted by genLine, genColumn
 * @property {Map<string, SourceFileInfo>} byPath
 * @property {number} genLineCount               - total generated lines
 */

/**
 * Parse source map file and build the index.
 * @param {string} mapPath
 * @returns {SourceMapIndex}
 */
export function parseSourceMap(mapPath) {
  const t0 = Date.now();
  log('sourcemap', `Parsing ${mapPath}...`);

  const raw = fs.readFileSync(mapPath, 'utf-8');
  const map = JSON.parse(raw);
  verbose('sourcemap', `JSON parsed (${map.sources.length} sources) in ${elapsed(t0)}`);

  // Build SourceFileInfo entries
  const sources = map.sources.map((srcPath, i) => ({
    index: i,
    path: srcPath,
    content: map.sourcesContent?.[i] ?? '',
    mappings: [],
  }));
  const byPath = new Map(sources.map(s => [s.path, s]));

  // Decode mappings
  const t1 = Date.now();
  const decodedLines = decodeMappings(map.mappings);
  verbose('sourcemap', `Mappings decoded (${decodedLines.length} gen lines) in ${elapsed(t1)}`);

  // Build flat sorted mapping array and per-source groupings
  const t2 = Date.now();
  const allMappings = [];

  for (let genLine = 0; genLine < decodedLines.length; genLine++) {
    const segments = decodedLines[genLine];
    for (const seg of segments) {
      if (seg.length < 4) continue; // skip segments without source info
      const mapping = {
        genLine,
        genColumn: seg[0],
        sourceIndex: seg[1],
        sourceLine: seg[2],
        sourceColumn: seg[3],
      };
      allMappings.push(mapping);
      if (seg[1] >= 0 && seg[1] < sources.length) {
        sources[seg[1]].mappings.push(mapping);
      }
    }
  }

  allMappings.sort((a, b) => a.genLine - b.genLine || a.genColumn - b.genColumn);

  verbose('sourcemap', `${allMappings.length} mappings indexed in ${elapsed(t2)}`);

  log('sourcemap', `Total parse time: ${elapsed(t0)}`);

  return {
    sources,
    allMappings,
    byPath,
    genLineCount: decodedLines.length,
  };
}

/**
 * Look up which source file and line a generated position maps to.
 * Uses binary search on allMappings (sorted by genLine, genColumn).
 * Returns the mapping whose genLine/genColumn is <= the query position.
 *
 * @param {SourceMapIndex} index
 * @param {number} genLine - 0-based
 * @param {number} genColumn - 0-based
 * @returns {SourceMapping|null}
 */
export function originalPositionFor(index, genLine, genColumn) {
  const mappings = index.allMappings;
  let lo = 0;
  let hi = mappings.length - 1;
  let best = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const m = mappings[mid];
    const cmp = m.genLine - genLine || m.genColumn - genColumn;
    if (cmp === 0) return m;
    if (cmp < 0) {
      best = m;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Only return if same line
  if (best && best.genLine === genLine) return best;

  // If best is on a wrong line (or null), scan forward for the first mapping
  // on the target line — handles queries before the first mapping segment.
  for (let i = lo; i < mappings.length; i++) {
    if (mappings[i].genLine === genLine) return mappings[i];
    if (mappings[i].genLine > genLine) break;
  }
  return null;
}

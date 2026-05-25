/**
 * Split a bundle into discrete ModuleChunk objects using detected boundaries.
 *
 * Each chunk contains its code slice, string literals that fall within it,
 * and positional metadata.
 */

import { offsetToLine } from './bundle-analyzer.mjs';
import { log, verbose, elapsed } from './utils.mjs';

/**
 * @typedef {Object} ModuleChunk
 * @property {number}   id         - sequential index
 * @property {'factory'|'lazy'|'preamble'|'interstitial'|'entry'} type
 * @property {string}   varName
 * @property {string}   wrapperName
 * @property {number}   start      - byte offset start
 * @property {number}   end        - byte offset end
 * @property {number}   bodyStart  - byte offset of body '{'
 * @property {number}   bodyEnd    - byte offset of body '}'
 * @property {number}   line       - 1-based start line
 * @property {number}   endLine    - 1-based end line
 * @property {string}   code       - raw code of the module body (between braces)
 * @property {import('./bundle-analyzer.mjs').StringLiteral[]} strings
 */

/**
 * Segment a bundle analysis into module chunks.
 *
 * @param {import('./bundle-analyzer.mjs').BundleAnalysis} analysis
 * @returns {ModuleChunk[]}
 */
export function segmentModules(analysis) {
  const t0 = Date.now();
  const { code, strings, modules, gaps, lineStarts } = analysis;

  // Build a lookup map from gap start offset to its typed info
  const gapByStart = new Map();
  if (gaps) {
    for (const gap of gaps) {
      gapByStart.set(gap.start, gap);
    }
  }

  const chunks = [];
  let prevEnd = 0;

  // Sort modules by start position (should already be sorted)
  const sorted = [...modules].sort((a, b) => a.start - b.start);

  for (let i = 0; i < sorted.length; i++) {
    const mod = sorted[i];

    // Add gap chunk for code between previous module and this one
    if (mod.start > prevEnd) {
      const topCode = code.slice(prevEnd, mod.start);
      if (topCode.trim().length > 0) {
        // Use the analyzer's gap type if available, otherwise fall back
        const gapInfo = gapByStart.get(prevEnd);
        const gapType = gapInfo ? gapInfo.type : (prevEnd === 0 ? 'preamble' : 'interstitial');
        chunks.push({
          id: chunks.length,
          type: gapType,
          varName: `__${gapType}_${chunks.length}`,
          wrapperName: '',
          start: prevEnd,
          end: mod.start,
          bodyStart: prevEnd,
          bodyEnd: mod.start,
          line: offsetToLine(lineStarts, prevEnd),
          endLine: offsetToLine(lineStarts, mod.start),
          code: topCode,
          strings: [],
        });
      }
    }

    // Add the module chunk
    const bodyCode = code.slice(mod.bodyStart, mod.bodyEnd + 1);
    chunks.push({
      id: chunks.length,
      type: mod.type,
      varName: mod.varName,
      wrapperName: mod.wrapperName,
      start: mod.start,
      end: mod.end,
      bodyStart: mod.bodyStart,
      bodyEnd: mod.bodyEnd,
      line: mod.line,
      endLine: mod.endLine,
      code: bodyCode,
      strings: [],
    });

    prevEnd = mod.end;
  }

  // Add trailing entry chunk
  if (prevEnd < code.length) {
    const topCode = code.slice(prevEnd);
    if (topCode.trim().length > 0) {
      const gapInfo = gapByStart.get(prevEnd);
      const gapType = gapInfo ? gapInfo.type : 'entry';
      chunks.push({
        id: chunks.length,
        type: gapType,
        varName: `__${gapType}_${chunks.length}`,
        wrapperName: '',
        start: prevEnd,
        end: code.length,
        bodyStart: prevEnd,
        bodyEnd: code.length,
        line: offsetToLine(lineStarts, prevEnd),
        endLine: offsetToLine(lineStarts, code.length - 1),
        code: topCode,
        strings: [],
      });
    }
  }

  // Assign strings to chunks using binary search on chunk boundaries
  const t1 = Date.now();
  assignStringsToChunks(chunks, strings);
  verbose('segmenter', `Assigned ${strings.length} strings to ${chunks.length} chunks in ${elapsed(t1)}`);

  log('segmenter', `Segmented into ${chunks.length} chunks (${chunks.filter(c => c.type === 'factory').length} factory, ${chunks.filter(c => c.type === 'lazy').length} lazy, ${chunks.filter(c => c.type === 'preamble').length} preamble, ${chunks.filter(c => c.type === 'interstitial').length} interstitial, ${chunks.filter(c => c.type === 'entry').length} entry) in ${elapsed(t0)}`);

  return chunks;
}

/**
 * Assign each string literal to the chunk it falls within.
 */
function assignStringsToChunks(chunks, strings) {
  // Build sorted half-open ranges [start, endExclusive) from the actual code
  // slice length so we avoid mixed inclusive/exclusive metadata semantics.
  const ranges = chunks.map((c, i) => [c.bodyStart, c.bodyStart + c.code.length, i]);
  ranges.sort((a, b) => a[0] - b[0]);

  for (const str of strings) {
    const offset = str.start;
    // Binary search for the chunk containing this offset
    let lo = 0, hi = ranges.length - 1;
    let found = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (ranges[mid][0] <= offset && offset < ranges[mid][1]) {
        found = ranges[mid][2];
        break;
      }
      if (offset < ranges[mid][0]) hi = mid - 1;
      else lo = mid + 1;
    }

    if (found >= 0) {
      chunks[found].strings.push(str);
    }
  }
}

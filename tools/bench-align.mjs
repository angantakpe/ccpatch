#!/usr/bin/env node
/**
 * Microbenchmark for the bundle-reconstructor alignment pipeline.
 *
 * Runs analyze → segment → align on a (base, target) pair and reports
 * per-phase wall-clock + heap delta. Designed to be a stable A/B harness
 * across refactors (no I/O outside reads, no sourcemap dependency).
 *
 * Usage:
 *   node tools/bench-align.mjs [base.cjs] [target.cjs] [--runs=N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyzeBundle } from './reconstructor/lib/bundle-analyzer.mjs';
import { segmentModules } from './reconstructor/lib/module-segmenter.mjs';
import { alignModules } from './reconstructor/lib/aligner.mjs';
import { setVerbose } from './reconstructor/lib/utils.mjs';

setVerbose(false);

const ARCHIVES = path.join(process.cwd(), 'storage/archives');
const args = process.argv.slice(2);
const runsArg = args.find(a => a.startsWith('--runs='));
const RUNS = runsArg ? parseInt(runsArg.slice(7), 10) : 3;
const positional = args.filter(a => !a.startsWith('--'));

const basePath   = positional[0] ?? path.join(ARCHIVES, 'claude-code-v2.1.145/cli.v2.1.145.cjs');
const targetPath = positional[1] ?? path.join(ARCHIVES, 'claude-code-v2.1.146/cli.v2.1.146.cjs');

if (!fs.existsSync(basePath))   { console.error(`base not found: ${basePath}`);   process.exit(1); }
if (!fs.existsSync(targetPath)) { console.error(`target not found: ${targetPath}`); process.exit(1); }

const emptySourceMap = { sources: [], allMappings: [] };

function now() { return Number(process.hrtime.bigint()) / 1e6; }
function mb(b) { return (b / 1024 / 1024).toFixed(1) + 'MB'; }

console.log(`base:   ${path.basename(basePath)}   (${mb(fs.statSync(basePath).size)})`);
console.log(`target: ${path.basename(targetPath)} (${mb(fs.statSync(targetPath).size)})`);
console.log(`runs:   ${RUNS}`);
console.log();

const results = [];

for (let run = 1; run <= RUNS; run++) {
  if (global.gc) global.gc();
  const heapStart = process.memoryUsage().heapUsed;

  const t0 = now();
  const baseAnalysis   = analyzeBundle(basePath);
  const targetAnalysis = analyzeBundle(targetPath);
  const tAnalyze = now() - t0;

  const t1 = now();
  const baseChunks   = segmentModules(baseAnalysis);
  const targetChunks = segmentModules(targetAnalysis);
  const tSegment = now() - t1;

  const t2 = now();
  const result = alignModules(baseChunks, targetChunks, emptySourceMap);
  const tAlign = now() - t2;

  const tTotal = now() - t0;
  const heapEnd = process.memoryUsage().heapUsed;

  results.push({
    run,
    analyze: tAnalyze,
    segment: tSegment,
    align: tAlign,
    total: tTotal,
    heapDelta: heapEnd - heapStart,
    matched: result.stats.matched,
    exact: result.stats.exact,
    modified: result.stats.modified,
  });

  console.log(`run ${run}: analyze=${tAnalyze.toFixed(0)}ms  segment=${tSegment.toFixed(0)}ms  align=${tAlign.toFixed(0)}ms  total=${tTotal.toFixed(0)}ms  heapΔ=${mb(heapEnd - heapStart)}  matched=${result.stats.matched} (exact=${result.stats.exact} modified=${result.stats.modified})`);
}

function summarize(key) {
  const xs = results.map(r => r[key]).sort((a, b) => a - b);
  const median = xs[Math.floor(xs.length / 2)];
  const min = xs[0], max = xs[xs.length - 1];
  return { median, min, max };
}

console.log();
console.log('summary (median of ' + RUNS + ' runs):');
for (const k of ['analyze', 'segment', 'align', 'total']) {
  const s = summarize(k);
  console.log(`  ${k.padEnd(8)} median=${s.median.toFixed(0)}ms  min=${s.min.toFixed(0)}ms  max=${s.max.toFixed(0)}ms`);
}

const sanity = results[0];
console.log();
console.log(`sanity: matched=${sanity.matched} exact=${sanity.exact} modified=${sanity.modified}`);

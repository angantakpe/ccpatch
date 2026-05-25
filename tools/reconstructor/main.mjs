#!/usr/bin/env node

/**
 * bundle-reconstructor — Règle de Trois
 *
 * Reconstruct Claude Code source from a new bundle using a known
 * bundle↔source mapping as the Rosetta Stone.
 *
 * Usage:
 *   node main.mjs \
 *     --base-bundle     <path to base cli.js> \
 *     --base-source     <path to base src/ directory> \
 *     --base-sourcemap  <path to base cli.js.map> \
 *     --target-bundle   <path to target cli.js> \
 *     --output          <output directory>
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { parseSourceMap } from './lib/sourcemap-parser.mjs';
import { analyzeBundle } from './lib/bundle-analyzer.mjs';
import { segmentModules } from './lib/module-segmenter.mjs';
import { alignModules } from './lib/aligner.mjs';
import { reconstruct } from './lib/reconstructor.mjs';
import { generateCoverageReport } from './lib/coverage-reporter.mjs';
import { elapsed, writeJSON, setVerbose } from './lib/utils.mjs';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    'base-bundle':    { type: 'string' },
    'base-source':    { type: 'string' },
    'base-sourcemap': { type: 'string' },
    'target-bundle':  { type: 'string' },
    'output':         { type: 'string' },
    'phase':          { type: 'string' },
    'verbose':        { type: 'boolean', default: false },
    'help':           { type: 'boolean', default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
bundle-reconstructor — Règle de Trois

Reconstruct Claude Code TypeScript source from a new minified bundle
using a known bundle↔source↔sourcemap triple as the Rosetta Stone.

USAGE:
  node main.mjs [OPTIONS]

REQUIRED:
  --base-bundle     Path to the base version's cli.js (known bundle)
  --base-source     Path to the base version's src/ directory (known source)
  --base-sourcemap  Path to the base version's cli.js.map (Rosetta Stone)
  --target-bundle   Path to the target version's cli.js (new bundle)
  --output          Output directory for reconstructed source

OPTIONS:
  --phase <name>    Run only a specific phase: sourcemap, analyze, align, reconstruct
  --verbose         Verbose output
  --help            Show this help

EXAMPLE:
  node main.mjs \\
    --base-bundle     storage/archives/claude-code-v2.1.88/cli.js \\
    --base-source     storage/archives/claude-code-source-v2.1.88/src \\
    --base-sourcemap  storage/archives/claude-code-source-build/source/cli.js.map \\
    --target-bundle   storage/archives/claude-code-v2.1.89/cli.js \\
    --output          storage/outputs/cc-v2.1.89
`);
  process.exit(0);
}

// Validate required args
const required = ['base-bundle', 'base-source', 'base-sourcemap', 'target-bundle', 'output'];
for (const name of required) {
  if (!args[name]) {
    console.error(`Missing required argument: --${name}`);
    console.error('Run with --help for usage information.');
    process.exit(1);
  }
}

// Resolve paths relative to CWD
const baseBundlePath    = path.resolve(args['base-bundle']);
const baseSourceDir     = path.resolve(args['base-source']);
const baseSourcemapPath = path.resolve(args['base-sourcemap']);
const targetBundlePath  = path.resolve(args['target-bundle']);
const outputDir         = path.resolve(args['output']);
const runPhase          = args['phase'] || null;
const verbose           = args['verbose'] || false;
setVerbose(verbose);

// Validate files exist
for (const [name, p] of [['base-bundle', baseBundlePath], ['base-sourcemap', baseSourcemapPath], ['target-bundle', targetBundlePath]]) {
  if (!fs.existsSync(p)) {
    console.error(`File not found: --${name} ${p}`);
    process.exit(1);
  }
}
if (!fs.existsSync(baseSourceDir)) {
  console.error(`Directory not found: --base-source ${baseSourceDir}`);
  process.exit(1);
}

// Extract version info from package.json siblings
function readVersion(bundlePath) {
  const pkgPath = path.join(path.dirname(bundlePath), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch (e) {
    console.warn(`[main] Could not read version from ${pkgPath}: ${e.message}`);
    return 'unknown';
  }
}

const baseVersion = readVersion(baseBundlePath);
const targetVersion = readVersion(targetBundlePath);

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  bundle-reconstructor — Règle de Trois                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Base:   v${baseVersion} (${path.basename(baseBundlePath)})`);
  console.log(`  Target: v${targetVersion} (${path.basename(targetBundlePath)})`);
  console.log(`  Output: ${outputDir}`);
  console.log();
  if (verbose) console.log('  Verbose mode enabled');

  // ── Phase 1: Parse source map ──────────────────────────────────────────

  if (!runPhase || runPhase === 'sourcemap') {
    console.log('━━━ Phase 1: Parsing source map (Rosetta Stone) ━━━');
  }

  const sourceMapIndex = parseSourceMap(baseSourcemapPath);
  console.log(`  → ${sourceMapIndex.sources.length} source files, ${sourceMapIndex.allMappings.length} mappings`);
  console.log();

  if (runPhase === 'sourcemap') {
    console.log(`Done (phase: sourcemap). ${elapsed(t0)}`);
    return;
  }

  // ── Phase 2: Analyze bundles ───────────────────────────────────────────

  console.log('━━━ Phase 2: Analyzing bundles ━━━');

  const baseAnalysis = analyzeBundle(baseBundlePath);
  const targetAnalysis = analyzeBundle(targetBundlePath);

  console.log(`  Base:   ${baseAnalysis.strings.length} strings, ${baseAnalysis.modules.length} modules`);
  console.log(`  Target: ${targetAnalysis.strings.length} strings, ${targetAnalysis.modules.length} modules`);
  console.log();

  // ── Phase 2b: Segment into chunks ──────────────────────────────────────

  console.log('━━━ Phase 2b: Segmenting modules ━━━');

  const baseChunks = segmentModules(baseAnalysis);
  const targetChunks = segmentModules(targetAnalysis);

  console.log(`  Base chunks:   ${baseChunks.length}`);
  console.log(`  Target chunks: ${targetChunks.length}`);
  console.log();

  if (runPhase === 'analyze') {
    console.log(`Done (phase: analyze). ${elapsed(t0)}`);
    return;
  }

  // ── Phase 3: Align modules ─────────────────────────────────────────────

  console.log('━━━ Phase 3: Aligning modules ━━━');

  const alignmentResult = alignModules(baseChunks, targetChunks, sourceMapIndex);
  console.log();

  if (runPhase === 'align') {
    // Write alignment results for inspection
    const alignOutPath = path.join(outputDir, 'alignment.json');
    fs.mkdirSync(outputDir, { recursive: true });
    writeJSON(alignOutPath, {
      stats: alignmentResult.stats,
      alignments: alignmentResult.alignments,
    });
    console.log(`Alignment written to ${alignOutPath}`);
    console.log(`Done (phase: align). ${elapsed(t0)}`);
    return;
  }

  // ── Phase 4: Reconstruct source tree ───────────────────────────────────

  console.log('━━━ Phase 4: Reconstructing source tree ━━━');

  // Source map paths already include "src/" prefix, so output directly to outputDir
  const reconstructResult = await reconstruct(
    alignmentResult, baseChunks, targetChunks,
    sourceMapIndex, baseSourceDir, outputDir
  );
  console.log();

  // ── Write runtime chunks (preamble, entry) ─────────────────────────────

  console.log('━━━ Writing runtime chunks (preamble, entry) ━━━');
  const runtimeDir = path.join(outputDir, '_runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  let runtimeCount = 0;
  for (const chunk of targetChunks) {
    if (chunk.type === 'preamble' || chunk.type === 'entry') {
      const filename = `${chunk.type}_${chunk.id}.js`;
      const header = [
        `// [RECONSTRUCTOR] Runtime ${chunk.type} chunk`,
        `// Lines: ${chunk.line}-${chunk.endLine}`,
        `// Size: ${chunk.code.length} chars`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(runtimeDir, filename), header + chunk.code);
      runtimeCount++;
    }
  }
  console.log(`  → ${runtimeCount} runtime chunks written to _runtime/`);
  console.log();

  // ── Copy metadata files from target bundle dir ──────────────────────────

  const targetDir = path.dirname(targetBundlePath);
  for (const name of ['package.json', 'LICENSE.md', 'README.md', 'bun.lock', 'sdk-tools.d.ts']) {
    const src = path.join(targetDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outputDir, name));
    }
  }
  // Copy vendor directory if present
  const vendorSrc = path.join(targetDir, 'vendor');
  if (fs.existsSync(vendorSrc)) {
    fs.cpSync(vendorSrc, path.join(outputDir, 'vendor'), { recursive: true });
  }

  // ── Generate coverage report ───────────────────────────────────────────

  console.log('━━━ Generating coverage report ━━━');

  generateCoverageReport(reconstructResult, alignmentResult, outputDir, {
    baseVersion,
    targetVersion,
    baseBundle: baseBundlePath,
    targetBundle: targetBundlePath,
  });

  console.log();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Reconstruction complete in ${elapsed(t0).padEnd(33)}║`);
  console.log(`║  Exact:    ${String(reconstructResult.exactCopied).padEnd(5)} files                                  ║`);
  console.log(`║  Modified: ${String(reconstructResult.modified).padEnd(5)} files                                  ║`);
  console.log(`║  New:      ${String(reconstructResult.newModules).padEnd(5)} modules                                ║`);
  console.log(`║  Deleted:  ${String(reconstructResult.deleted).padEnd(5)} files                                  ║`);
  console.log(`║  Runtime:  ${String(runtimeCount).padEnd(5)} chunks (_runtime/)                     ║`);
  console.log(`║  Output:   ${outputDir.slice(-47).padEnd(48)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

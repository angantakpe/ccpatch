/**
 * Phase 4: Reconstruct source tree from alignment results.
 *
 * - Exact matches: copy source file verbatim from base source tree
 * - Modified matches: apply real diffs from minified bundle comparison
 * - New modules: beautified and modernized JS (via prettier + lebab)
 * - Generates a manifest of all reconstructed files
 */

import fs from 'node:fs';
import path from 'node:path';
import { diffWords } from 'diff';
import prettier from 'prettier';
import { transform as lebabTransform } from 'lebab';
import { originalPositionFor } from './sourcemap-parser.mjs';
import { log, verbose, elapsed, writeText, fileExists } from './utils.mjs';

// Lebab transforms to apply (safe transforms that improve readability)
const LEBAB_TRANSFORMS = [
  'let',              // var → let/const
  'arrow',            // function() → () =>
  'arrow-return',     // () => { return x } → () => x
  'template',         // string concat → template literals
  'default-param',    // arguments[0] || default → default params
  'destruct-param',   // options.x → { x }
  'obj-shorthand',    // { x: x } → { x }
  'obj-method',       // { fn: function() {} } → { fn() {} }
  'for-of',           // for (var i = 0; ...) → for (const x of ...)
  'exponent',         // Math.pow(x, 2) → x ** 2
  'multi-var',        // var a, b → let a; let b
];

/** Set of chunk types that represent non-module gap code. */
const GAP_TYPES = new Set(['preamble', 'interstitial', 'entry']);
function isGapChunk(chunk) { return chunk && GAP_TYPES.has(chunk.type); }

/**
 * @typedef {Object} ReconstructionResult
 * @property {number} exactCopied     - files copied verbatim
 * @property {number} modified        - files with change annotations
 * @property {number} newModules      - new modules (beautified via prettier+lebab)
 * @property {number} deleted         - modules present in base but not target
 * @property {number} skipped         - files with no base content found
 * @property {string[]} skippedFiles  - paths of skipped files
 * @property {string[]} allFiles      - all output file paths (relative)
 * @property {Object[]} manifest      - per-file reconstruction metadata
 */

/**
 * Reconstruct the source tree.
 *
 * @param {import('./aligner.mjs').AlignmentResult} alignment
 * @param {import('./module-segmenter.mjs').ModuleChunk[]} baseChunks
 * @param {import('./module-segmenter.mjs').ModuleChunk[]} targetChunks
 * @param {import('./sourcemap-parser.mjs').SourceMapIndex} sourceMapIndex
 * @param {string} baseSourceDir   - path to base source tree (e.g. .../storage/archives/claude-code-source-v2.1.88/src)
 * @param {string} outputDir       - output directory
 * @returns {Promise<ReconstructionResult>}
 */
export async function reconstruct(alignment, baseChunks, targetChunks, sourceMapIndex, baseSourceDir, outputDir) {
  const t0 = Date.now();
  log('reconstruct', `Reconstructing to ${outputDir}...`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const result = {
    exactCopied: 0,
    modified: 0,
    newModules: 0,
    deleted: 0,
    skipped: 0,
    skippedFiles: [],
    allFiles: [],
    manifest: [],
  };

  // Collect all source files and their alignment status
  const sourceFileStatus = new Map(); // path -> { matchType, confidence, alignments[] }

  // First pass: count how many files each alignment maps to.
  // Modules that map to 10+ files are "shared" and shouldn't drag all those files
  // into "modified" status — their changes are too diffuse to attribute.
  const alignmentFileCount = new Map(); // alignment -> number of source files
  for (const a of alignment.alignments) {
    alignmentFileCount.set(a, a.sourceFiles.length);
  }

  for (const a of alignment.alignments) {
    for (const srcFile of a.sourceFiles) {
      if (!sourceFileStatus.has(srcFile)) {
        sourceFileStatus.set(srcFile, {
          matchType: 'exact',
          confidence: 1.0,
          alignments: [],
        });
      }
      sourceFileStatus.get(srcFile).alignments.push(a);
    }
  }

  // Classify files based on aggregate alignment quality
  for (const [, status] of sourceFileStatus) {
    const total = status.alignments.length;
    if (total === 0) continue;

    // Only count "focused" alignments — modules that map to ≤10 files.
    // Shared modules (mapping to 10+ files) are too diffuse to reliably attribute.
    const focusedAlignments = status.alignments.filter(a => alignmentFileCount.get(a) <= 10);
    const focusedTotal = focusedAlignments.length;
    const exactCount = focusedAlignments.filter(a => a.matchType === 'exact').length;
    const modifiedAlignments = focusedAlignments.filter(a => a.matchType === 'modified');
    const deletedCount = focusedAlignments.filter(a => a.matchType === 'deleted').length;

    if (focusedTotal === 0) {
      // All modules are shared — treat as exact (shared modules' changes
      // are too diffuse to meaningfully attribute to this file)
      status.matchType = 'exact';
      status.confidence = 1.0;
      // Only keep focused alignments for diff application
      status.alignments = [];
    } else {
      const exactRatio = exactCount / focusedTotal;
      if (exactRatio === 1.0 && deletedCount === 0) {
        status.matchType = 'exact';
        status.confidence = 1.0;
      } else if (deletedCount > focusedTotal * 0.5) {
        status.matchType = 'deleted';
        status.confidence = 0;
      } else {
        status.matchType = 'modified';
        const avgConf = modifiedAlignments.length > 0
          ? modifiedAlignments.reduce((s, a) => s + a.confidence, 0) / modifiedAlignments.length
          : exactRatio;
        status.confidence = avgConf;
      }
      // Only keep focused alignments for diff application
      status.alignments = focusedAlignments;
    }
  }

  // Also find source files NOT referenced by any alignment (unchanged files)
  // These exist in the source map but their modules all matched exactly
  const allSourceFiles = new Set();
  let skippedNonSrc = 0;
  let skippedNoContent = 0;
  for (const src of sourceMapIndex.sources) {
    if (!src.path.includes('/src/')) {
      skippedNonSrc++;
      continue;
    }
    if (!src.content) {
      skippedNoContent++;
      continue;
    }
    const normalized = src.path.replace(/^\.\.\//, '');
    allSourceFiles.add(normalized);
  }
  if (skippedNonSrc > 0) {
    verbose('reconstruct', `  Skipped ${skippedNonSrc} source map entries outside /src/ (config files, scripts, etc.)`);
  }
  if (skippedNoContent > 0) {
    verbose('reconstruct', `  WARNING: ${skippedNoContent} source map entries had no content and were skipped`);
  }

  // Process each source file
  for (const srcPath of allSourceFiles) {
    const status = sourceFileStatus.get(srcPath);
    const basePath = path.join(baseSourceDir, srcPath.replace(/^src\//, ''));
    const outPath = path.join(outputDir, srcPath);

    // Try to read from base source directory first, fall back to source map content
    let baseContent = null;
    if (fileExists(basePath)) {
      baseContent = fs.readFileSync(basePath, 'utf-8');
    } else {
      // Try source map content — try the exact path first, then with ../ prefix
      const srcInfo = sourceMapIndex.byPath.get(srcPath)
        || sourceMapIndex.byPath.get(`../${srcPath}`)
        || sourceMapIndex.byPath.get(`../../${srcPath}`);
      if (srcInfo?.content) {
        baseContent = srcInfo.content;
      }
    }

    if (!baseContent) {
      result.skipped++;
      result.skippedFiles.push(srcPath);
      result.manifest.push({
        path: srcPath,
        type: 'skipped',
        confidence: 0,
      });
      continue;
    }

    if (!status || status.matchType === 'exact') {
      // Exact copy
      writeText(outPath, baseContent);
      result.exactCopied++;
      result.allFiles.push(srcPath);
      result.manifest.push({
        path: srcPath,
        type: 'exact',
        confidence: 1.0,
      });
    } else if (status.matchType === 'modified') {
      // Modified: apply real diffs from minified bundle comparison
      const modResult = annotateModifiedFile(
        baseContent, srcPath, status, baseChunks, targetChunks, sourceMapIndex
      );

      // If no real diffs could be applied and confidence is low, try reconstructing
      // the relevant sections from the target bundle's minified code directly
      if (modResult.realDiffCount === 0 && status.confidence < 0.9) {
        const targetReconstruction = await reconstructFromTarget(
          baseContent, srcPath, status, baseChunks, targetChunks, sourceMapIndex
        );
        if (targetReconstruction) {
          writeText(outPath, targetReconstruction.content);
          result.modified++;
          result.allFiles.push(srcPath);
          result.manifest.push({
            path: srcPath,
            type: 'modified',
            confidence: status.confidence,
            moduleCount: status.alignments.length,
            hasDiffs: true,
            realDiffCount: targetReconstruction.realDiffCount,
            annotationCount: targetReconstruction.annotationCount,
            unmappedCount: targetReconstruction.unmappedCount,
          });
          continue;
        }
      }

      writeText(outPath, modResult.content);
      result.modified++;
      result.allFiles.push(srcPath);
      result.manifest.push({
        path: srcPath,
        type: 'modified',
        confidence: status.confidence,
        moduleCount: status.alignments.length,
        hasDiffs: modResult.realDiffCount > 0,
        realDiffCount: modResult.realDiffCount,
        annotationCount: modResult.annotationCount,
        unmappedCount: modResult.unmappedCount,
      });
    } else if (status.matchType === 'deleted') {
      // File was removed in target — do NOT write it to output (it's stale)
      result.deleted++;
      result.manifest.push({
        path: srcPath,
        type: 'deleted',
        confidence: 0,
      });
    }
  }

  // Write new modules (no base match) — beautified and modernized
  const newModuleDir = path.join(outputDir, '_new_modules');
  const newModuleAlignments = alignment.alignments.filter(a => a.matchType === 'new');
  
  if (newModuleAlignments.length > 0) {
    verbose('reconstruct', `Beautifying ${newModuleAlignments.length} new modules with prettier + lebab...`);
  }

  for (const a of newModuleAlignments) {
    const chunk = targetChunks[a.targetChunkId];
    if (!chunk || isGapChunk(chunk)) continue;

    // Use .ts extension so new modules integrate with the TypeScript project.
    // The code is beautified JS, but .ts allows gradual type annotation.
    const filename = `module_${a.targetChunkId}_${chunk.varName}.reconstructed.ts`;
    const outPath = path.join(newModuleDir, filename);

    // Beautify the code
    const { code: beautified, transforms, errors } = await beautifyNewModule(chunk.code);

    // Infer likely export pattern from the module's strings and code
    const hasDefaultExport = /export\s+default\b/.test(chunk.code) || /exports\s*=/.test(chunk.code);
    const namedExports = [...chunk.code.matchAll(/exports\.(\w+)\s*=/g)].map(m => m[1]);

    const header = [
      '// [RECONSTRUCTOR] New module — not present in base version',
      `// Target chunk ID: ${a.targetChunkId}`,
      `// Variable name: ${chunk.varName}`,
      `// Type: ${chunk.type}`,
      `// Lines: ${chunk.line}-${chunk.endLine}`,
      `// String count: ${chunk.strings.length}`,
      transforms.length > 0 ? `// Lebab transforms applied: ${transforms.join(', ')}` : '// Lebab: no transforms applied',
      errors.length > 0 ? `// Beautify warnings: ${errors.join('; ')}` : null,
      hasDefaultExport ? '// Detected: default export' : null,
      namedExports.length > 0 ? `// Detected named exports: ${namedExports.join(', ')}` : null,
      '',
      '// Top strings found in this module:',
      ...chunk.strings.slice(0, 15).map(s => `//   "${s.value.slice(0, 80)}"`),
      '',
      '// @ts-nocheck — auto-generated from minified JS, needs manual type annotation',
      '',
    ].filter(Boolean).join('\n');

    writeText(outPath, header + beautified);
    result.newModules++;
    result.allFiles.push(`_new_modules/${filename}`);
    result.manifest.push({
      path: `_new_modules/${filename}`,
      type: 'new',
      confidence: 0,
      targetChunkId: a.targetChunkId,
      beautified: true,
      transforms,
    });
  }

  log('reconstruct', `Done in ${elapsed(t0)}: ${result.exactCopied} exact, ${result.modified} modified, ${result.newModules} new, ${result.deleted} deleted, ${result.skipped} skipped`);

  return result;
}

// ---------------------------------------------------------------------------
// annotateModifiedFile — the core reconstruction logic for modified files
// ---------------------------------------------------------------------------

/**
 * Reconstruct a modified source file by applying real diffs from the minified bundle.
 *
 * Strategy:
 * 1. For each modified module, diff the base and target minified code
 * 2. For string literal changes: find occurrences in the TypeScript source and replace
 * 3. For structural (non-string) changes: use source map to locate the region in
 *    the TypeScript source and mark it with inline comments
 * 4. Report what was applied vs what couldn't be mapped
 */
function annotateModifiedFile(baseContent, srcPath, status, baseChunks, targetChunks, sourceMapIndex) {
  const moduleDiffs = [];
  let appliedCount = 0;
  let unmappedCount = 0;

  // Collect all changes across modified modules that touch this file
  const stringReplacements = [];   // { oldStr, newStr } -- direct string literal swaps
  const structuralChanges = [];    // { sourceLine, added, removed } -- marked inline

  for (const a of status.alignments) {
    if (a.matchType !== 'modified') continue;

    const baseChunk = baseChunks[a.baseChunkId];
    const targetChunk = targetChunks[a.targetChunkId];
    if (!baseChunk || !targetChunk) continue;

    const sizeDelta = targetChunk.code.length - baseChunk.code.length;

    // --- 1. Detect string literal changes (most reliable for reconstruction) ---
    const baseStringMap = new Map(); // value -> [StringLiteral, ...]
    for (const s of baseChunk.strings) {
      if (!baseStringMap.has(s.value)) baseStringMap.set(s.value, []);
      baseStringMap.get(s.value).push(s);
    }
    const targetStringMap = new Map();
    for (const s of targetChunk.strings) {
      if (!targetStringMap.has(s.value)) targetStringMap.set(s.value, []);
      targetStringMap.get(s.value).push(s);
    }

    const baseStringsSet = new Set(baseStringMap.keys());
    const targetStringsSet = new Set(targetStringMap.keys());
    const addedStrings = [...targetStringsSet].filter(s => !baseStringsSet.has(s));
    const removedStrings = [...baseStringsSet].filter(s => !targetStringsSet.has(s));

    // Pair removed->added strings by position proximity in the minified code
    const pairedReplacements = pairStringChanges(
      removedStrings, addedStrings, baseStringMap, targetStringMap, baseChunk, targetChunk
    );
    stringReplacements.push(...pairedReplacements);

    // Track unpaired added/removed strings as structural changes
    const pairedOld = new Set(pairedReplacements.map(r => r.oldStr));
    const pairedNew = new Set(pairedReplacements.map(r => r.newStr));
    const unpairedRemoved = removedStrings.filter(s => !pairedOld.has(s));
    const unpairedAdded = addedStrings.filter(s => !pairedNew.has(s));

    // --- 2. Detect structural (non-string) code changes ---
    const codeDiffs = diffWords(baseChunk.code, targetChunk.code);
    const structChangesForModule = extractStructuralChanges(
      codeDiffs, baseChunk, sourceMapIndex, srcPath
    );
    structuralChanges.push(...structChangesForModule);

    moduleDiffs.push({
      confidence: a.confidence,
      sizeDelta,
      pairedReplacements: pairedReplacements.length,
      unpairedAdded: unpairedAdded.slice(0, 10),
      unpairedRemoved: unpairedRemoved.slice(0, 10),
      structuralChangeCount: structChangesForModule.length,
    });
  }

  if (moduleDiffs.length === 0) return { content: baseContent, realDiffCount: 0, annotationCount: 0, unmappedCount: 0 };

  // --- Apply changes to the source content ---
  let modifiedContent = baseContent;

  // Pass 1: Apply string replacements (high confidence -- literal text swaps)
  // Deduplicate by oldStr — if multiple modules replace the same string differently,
  // keep only the first occurrence (from the highest-confidence module, since
  // stringReplacements is populated in alignment order which is confidence-sorted)
  const seenOldStrs = new Set();
  const dedupedReplacements = [];
  for (const pair of stringReplacements) {
    if (!seenOldStrs.has(pair.oldStr)) {
      seenOldStrs.add(pair.oldStr);
      dedupedReplacements.push(pair);
    }
  }

  let realDiffCount = 0;   // actual code modifications (string swaps)
  let annotationCount = 0; // structural annotations (comments only)
  for (const { oldStr, newStr } of dedupedReplacements) {
    const replaced = applyStringReplacement(modifiedContent, oldStr, newStr);
    if (replaced !== modifiedContent) {
      modifiedContent = replaced;
      appliedCount++;
      realDiffCount++;
    } else {
      unmappedCount++;
    }
  }

  // Pass 2: Apply structural changes as actual code modifications where possible.
  // Group by source line to apply changes at the right location.
  const lineChanges = new Map(); // sourceLine (0-based) -> change[]
  for (const change of structuralChanges) {
    if (change.sourceLine < 0) {
      unmappedCount++;
      continue;
    }
    if (!lineChanges.has(change.sourceLine)) {
      lineChanges.set(change.sourceLine, []);
    }
    lineChanges.get(change.sourceLine).push(change);
  }

  if (lineChanges.size > 0) {
    const outLines = modifiedContent.split('\n');
    // Process in reverse line order to preserve line numbers
    const sortedLines = [...lineChanges.keys()].sort((a, b) => b - a);
    for (const lineIdx of sortedLines) {
      const changes = lineChanges.get(lineIdx);
      if (lineIdx >= 0 && lineIdx < outLines.length) {
        const originalLine = outLines[lineIdx];
        const indent = originalLine.match(/^(\s*)/)?.[1] || '';
        let lineModified = false;

        // Try to apply removals/additions directly on the source line
        for (const c of changes) {
          if (c.removed && c.added) {
            // Both removed and added — try direct text replacement on the line
            // The removed/added are normalized, so try finding substrings
            const removedTrimmed = c.removed.trim();
            const addedTrimmed = c.added.trim();
            if (removedTrimmed.length > 3 && outLines[lineIdx].includes(removedTrimmed)) {
              outLines[lineIdx] = outLines[lineIdx].replace(removedTrimmed, addedTrimmed);
              realDiffCount++;
              lineModified = true;
            }
          }
        }

        // If we couldn't apply inline, add as annotation with the actual diff content
        if (!lineModified) {
          const markers = changes.map(c => {
            const parts = [];
            if (c.removed) parts.push(`- ${truncate(c.removed, 80)}`);
            if (c.added) parts.push(`+ ${truncate(c.added, 80)}`);
            return parts.join(' | ');
          });
          outLines.splice(lineIdx, 0,
            `${indent}// [RECONSTRUCTOR] ${markers.join('; ')}`
          );
          annotationCount += changes.length;
        }
        appliedCount += changes.length;
      } else {
        unmappedCount += changes.length;
      }
    }
    modifiedContent = outLines.join('\n');
  }

  // --- Build header ---
  // DIFF APPLIED = actual code changes (string swaps), not just annotation comments
  const diffAppliedMarker = realDiffCount > 0 ? ' [RECONSTRUCTOR] DIFF APPLIED' : '';
  const header = [
    `// [RECONSTRUCTOR] MODIFIED FILE — confidence: ${(status.confidence * 100).toFixed(0)}%${diffAppliedMarker}`,
    `// Reconstructed from base source with ${realDiffCount} code change(s), ${annotationCount} structural annotation(s), ${unmappedCount} unmapped`,
  ];

  for (let i = 0; i < moduleDiffs.length; i++) {
    const md = moduleDiffs[i];
    header.push(`//   Module ${i + 1}: confidence=${(md.confidence * 100).toFixed(0)}%, size delta=${md.sizeDelta > 0 ? '+' : ''}${md.sizeDelta} chars, ${md.pairedReplacements} string swap(s), ${md.structuralChangeCount} structural change(s)`);
    if (md.unpairedAdded.length > 0) {
      header.push(`//     + Unpaired strings added: ${md.unpairedAdded.map(s => `"${s.slice(0, 50)}"`).join(', ')}`);
    }
    if (md.unpairedRemoved.length > 0) {
      header.push(`//     - Unpaired strings removed: ${md.unpairedRemoved.map(s => `"${s.slice(0, 50)}"`).join(', ')}`);
    }
  }

  if (unmappedCount > 0) {
    header.push(`// [WARNING] ${unmappedCount} change(s) could not be mapped to source — review manually`);
  }
  header.push('// [END RECONSTRUCTOR ANNOTATIONS]');
  header.push('');

  return {
    content: header.join('\n') + modifiedContent,
    realDiffCount,
    annotationCount,
    unmappedCount,
  };
}

// ---------------------------------------------------------------------------
// Target-based reconstruction for files where base diffs couldn't be applied
// ---------------------------------------------------------------------------

/**
 * When annotation-based reconstruction fails (0 real diffs, low confidence),
 * reconstruct the file by extracting the target module code, beautifying it,
 * and splicing it into the base source at the right locations.
 *
 * Returns null if this approach also can't improve the result.
 */
async function reconstructFromTarget(baseContent, srcPath, status, baseChunks, targetChunks, sourceMapIndex) {
  const modifiedAlignments = status.alignments.filter(a => a.matchType === 'modified');
  if (modifiedAlignments.length === 0) return null;

  let modifiedContent = baseContent;
  let realDiffCount = 0;
  let annotationCount = 0;
  let unmappedCount = 0;

  for (const a of modifiedAlignments) {
    const baseChunk = baseChunks[a.baseChunkId];
    const targetChunk = targetChunks[a.targetChunkId];
    if (!baseChunk || !targetChunk) continue;

    // Extract all string literal changes and apply them
    const baseStringSet = new Set(baseChunk.strings.map(s => s.value));
    const targetStringSet = new Set(targetChunk.strings.map(s => s.value));

    // Find strings that exist in target but not in base — these are additions/changes
    const newStrings = [...targetStringSet].filter(s => !baseStringSet.has(s));
    const removedStrings = [...baseStringSet].filter(s => !targetStringSet.has(s));

    // Pair and apply string replacements
    const pairs = pairStringChanges(
      removedStrings, newStrings,
      (() => { const m = new Map(); for (const s of baseChunk.strings) { if (!m.has(s.value)) m.set(s.value, []); m.get(s.value).push(s); } return m; })(),
      (() => { const m = new Map(); for (const s of targetChunk.strings) { if (!m.has(s.value)) m.set(s.value, []); m.get(s.value).push(s); } return m; })(),
      baseChunk, targetChunk
    );

    for (const { oldStr, newStr } of pairs) {
      const replaced = applyStringReplacement(modifiedContent, oldStr, newStr);
      if (replaced !== modifiedContent) {
        modifiedContent = replaced;
        realDiffCount++;
      }
    }

    // For remaining unpaired new strings, add them as comments near the source location
    const pairedNew = new Set(pairs.map(p => p.newStr));
    const unpairedNew = newStrings.filter(s => !pairedNew.has(s) && s.length > 5);
    if (unpairedNew.length > 0) {
      // Map to source line and add as annotation
      const sourceLine = mapOffsetToSourceLine(
        baseChunk.bodyStart || baseChunk.start, baseChunk, sourceMapIndex, srcPath
      );
      if (sourceLine >= 0) {
        const outLines = modifiedContent.split('\n');
        if (sourceLine < outLines.length) {
          const indent = outLines[sourceLine].match(/^(\s*)/)?.[1] || '';
          const newStrs = unpairedNew.slice(0, 5).map(s => `"${truncate(s, 60)}"`).join(', ');
          outLines.splice(sourceLine, 0,
            `${indent}// [RECONSTRUCTOR] New strings in this section: ${newStrs}`
          );
          modifiedContent = outLines.join('\n');
          annotationCount++;
        }
      } else {
        unmappedCount += unpairedNew.length;
      }
    }
  }

  // Only return if we actually improved over the annotation-only approach
  if (realDiffCount === 0) return null;

  const header = [
    `// [RECONSTRUCTOR] MODIFIED FILE — confidence: ${(status.confidence * 100).toFixed(0)}% [RECONSTRUCTOR] DIFF APPLIED`,
    `// Reconstructed with ${realDiffCount} code change(s), ${annotationCount} annotation(s), ${unmappedCount} unmapped`,
    '// [END RECONSTRUCTOR ANNOTATIONS]',
    '',
  ].join('\n');

  return {
    content: header + modifiedContent,
    realDiffCount,
    annotationCount,
    unmappedCount,
  };
}

// ---------------------------------------------------------------------------
// String replacement helpers
// ---------------------------------------------------------------------------

/**
 * Pair removed strings with added strings by their relative offset position
 * in the minified code. When a string is replaced, the old and new tend to
 * appear at similar byte offsets in the base vs target chunk.
 *
 * Uses greedy nearest-offset assignment.
 */
function pairStringChanges(removedStrings, addedStrings, baseStringMap, targetStringMap, baseChunk, targetChunk) {
  if (removedStrings.length === 0 || addedStrings.length === 0) return [];

  const baseStart = baseChunk.bodyStart || baseChunk.start;
  const targetStart = targetChunk.bodyStart || targetChunk.start;
  const baseLen = baseChunk.code.length || 1;
  const targetLen = targetChunk.code.length || 1;

  const candidates = [];
  for (const oldStr of removedStrings) {
    const baseEntries = baseStringMap.get(oldStr) || [];
    const baseOffset = baseEntries.length > 0
      ? baseEntries.reduce((sum, e) => sum + Math.max(0, e.start - baseStart), 0) / (baseEntries.length * baseLen)
      : 0.5;

    for (const newStr of addedStrings) {
      const targetEntries = targetStringMap.get(newStr) || [];
      const targetOffset = targetEntries.length > 0
        ? targetEntries.reduce((sum, e) => sum + Math.max(0, e.start - targetStart), 0) / (targetEntries.length * targetLen)
        : 0.5;

      const posDist = Math.abs(baseOffset - targetOffset);
      const lenRatio = Math.min(oldStr.length, newStr.length) / Math.max(oldStr.length, newStr.length, 1);
      // Score: lower is better (closer position + similar length)
      const score = posDist + (1 - lenRatio) * 0.5;

      candidates.push({ oldStr, newStr, score });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const usedOld = new Set();
  const usedNew = new Set();
  const pairs = [];

  for (const { oldStr, newStr, score } of candidates) {
    if (usedOld.has(oldStr) || usedNew.has(newStr)) continue;
    if (score > 1.5) continue;
    pairs.push({ oldStr, newStr });
    usedOld.add(oldStr);
    usedNew.add(newStr);
  }

  return pairs;
}

/**
 * Apply a string literal replacement in TypeScript source.
 * Handles single-quoted, double-quoted, and backtick-quoted forms.
 *
 * @returns {string} modified source, or original if no replacement was made
 */
function applyStringReplacement(source, oldStr, newStr) {
  let modified = source;
  let anyChange = false;

  for (const [open, close] of [['"', '"'], ["'", "'"], ['`', '`']]) {
    const escaped = escapeForStringLiteral(oldStr, open);
    const escapedNew = escapeForStringLiteral(newStr, open);
    const needle = `${open}${escaped}${close}`;
    const replacement = `${open}${escapedNew}${close}`;

    // Replace ALL occurrences — the string was specifically identified as changed
    // in a minified module mapped to this source file, so all instances should update
    let idx = modified.indexOf(needle);
    while (idx !== -1) {
      modified = modified.slice(0, idx) + replacement + modified.slice(idx + needle.length);
      anyChange = true;
      // Continue searching after the replacement to avoid infinite loops
      idx = modified.indexOf(needle, idx + replacement.length);
    }
  }

  return anyChange ? modified : source;
}

/**
 * Escape a string value for inclusion inside a string literal with the given quote char.
 */
function escapeForStringLiteral(str, quote) {
  let result = str
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  if (quote === '"') result = result.replace(/"/g, '\\"');
  else if (quote === "'") result = result.replace(/'/g, "\\'");
  else if (quote === '`') result = result.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

  return result;
}

// ---------------------------------------------------------------------------
// Structural diff helpers
// ---------------------------------------------------------------------------

/**
 * Extract structural (non-string-literal) changes from a normalized diff
 * and map them back to source file lines via the source map.
 *
 * @param {Array} codeDiffs - output of diffWords on normalized code
 * @param {import('./module-segmenter.mjs').ModuleChunk} baseChunk
 * @param {import('./sourcemap-parser.mjs').SourceMapIndex} sourceMapIndex
 * @param {string} srcPath - the source file we're reconstructing
 * @returns {Array<{sourceLine: number, added: string|null, removed: string|null}>}
 */
function extractStructuralChanges(codeDiffs, baseChunk, sourceMapIndex, srcPath) {
  const changes = [];
  if (!sourceMapIndex) return changes;

  let baseOffset = 0;
  const chunkBodyStart = baseChunk.bodyStart || baseChunk.start;

  let pendingRemoval = null; // { sourceLine, trimmed, rawLength }

  for (const part of codeDiffs) {
    if (part.removed) {
      // Flush any prior pending removal that wasn't fused with an added part
      if (pendingRemoval) {
        if (pendingRemoval.trimmed.length > 2) {
          changes.push({ sourceLine: pendingRemoval.sourceLine, added: null, removed: pendingRemoval.trimmed });
        }
      }
      // Buffer this removal — it may fuse with the next added part
      const sourceLine = mapOffsetToSourceLine(
        chunkBodyStart + baseOffset, baseChunk, sourceMapIndex, srcPath
      );
      const trimmed = part.value.trim();
      pendingRemoval = { sourceLine, trimmed, rawLength: part.value.length };
      baseOffset += part.value.length;
    } else if (part.added) {
      const trimmed = part.value.trim();
      if (pendingRemoval) {
        // Fuse consecutive removed+added into a single replacement change
        if (pendingRemoval.trimmed.length > 2 || trimmed.length > 2) {
          changes.push({
            sourceLine: pendingRemoval.sourceLine,
            added: trimmed.length > 2 ? trimmed : null,
            removed: pendingRemoval.trimmed.length > 2 ? pendingRemoval.trimmed : null,
          });
        }
        pendingRemoval = null;
      } else {
        // Added code with no preceding removal
        const sourceLine = mapOffsetToSourceLine(
          chunkBodyStart + baseOffset, baseChunk, sourceMapIndex, srcPath
        );
        if (trimmed.length > 2) {
          changes.push({ sourceLine, added: trimmed, removed: null });
        }
      }
    } else {
      // Unchanged part -- flush any pending removal first
      if (pendingRemoval) {
        if (pendingRemoval.trimmed.length > 2) {
          changes.push({ sourceLine: pendingRemoval.sourceLine, added: null, removed: pendingRemoval.trimmed });
        }
        pendingRemoval = null;
      }
      baseOffset += part.value.length;
    }
  }

  // Flush any trailing pending removal
  if (pendingRemoval) {
    if (pendingRemoval.trimmed.length > 2) {
      changes.push({ sourceLine: pendingRemoval.sourceLine, added: null, removed: pendingRemoval.trimmed });
    }
  }

  return changes;
}

/**
 * Map a byte offset within a base chunk's minified code to a source line number
 * in the target TypeScript file, using the source map.
 *
 * @returns {number} 0-based line number in the source file, or -1 if unmappable
 */
function mapOffsetToSourceLine(genOffset, baseChunk, sourceMapIndex, srcPath) {
  const chunkBodyStart = baseChunk.bodyStart || baseChunk.start;
  const offsetInChunk = genOffset - chunkBodyStart;
  const codeSlice = baseChunk.code.slice(0, Math.max(0, offsetInChunk));
  const newlineCount = countNewlines(codeSlice);
  const genLine = (baseChunk.line - 1) + newlineCount; // 0-based

  // Compute column relative to the start of genLine in the full bundle file.
  // Source map columns are offsets from the start of the generated line in the
  // FULL bundle, not from the start of the chunk's code.
  const lastNewline = codeSlice.lastIndexOf('\n');
  let genColumn;
  if (lastNewline >= 0) {
    // Last newline is at absolute position (chunkBodyStart + lastNewline) in the bundle.
    // Column = offset from that newline to genOffset.
    genColumn = genOffset - (chunkBodyStart + lastNewline + 1);
  } else {
    // No newlines in the code slice — we're on the same line the chunk starts on.
    // For a single-line bundle (genLine === 0), line starts at byte 0, so column = genOffset.
    // For other lines, genOffset is the absolute bundle offset which equals the column
    // since the chunk's var declaration and body are on the same line.
    genColumn = genOffset;
  }

  const mapping = originalPositionFor(sourceMapIndex, genLine, genColumn);
  if (!mapping) return -1;

  const src = sourceMapIndex.sources[mapping.sourceIndex];
  if (!src) return -1;
  const normalizedPath = src.path.replace(/^\.\.\//, '');
  if (normalizedPath !== srcPath) return -1;

  return mapping.sourceLine;
}

// ---------------------------------------------------------------------------
// New module beautification (prettier + lebab)
// ---------------------------------------------------------------------------

/**
 * Beautify and modernize a new module's minified code.
 *
 * Pipeline:
 * 1. Run lebab to reverse ES5→ES6 patterns (var→let, arrow functions, etc.)
 * 2. Run prettier to format the code nicely
 *
 * @param {string} code - raw minified module code
 * @returns {Promise<{code: string, transforms: string[], errors: string[]}>}
 */
async function beautifyNewModule(code) {
  const errors = [];
  const appliedTransforms = [];
  let result = code;

  // Step 1: Lebab modernization
  try {
    const { code: modernized, warnings } = lebabTransform(result, LEBAB_TRANSFORMS);
    if (modernized && modernized !== result) {
      result = modernized;
      // Detect applied transforms via simple heuristics (avoids running lebab 12 more times)
      if (/\b(let|const)\b/.test(result) && /\bvar\b/.test(code)) appliedTransforms.push('let');
      if (/\w+\s*=>/.test(result)) appliedTransforms.push('arrow');
      if (/`[^`]*\$\{/.test(result)) appliedTransforms.push('template');
      if (/\*\*\s*\d/.test(result) && /Math\.pow/.test(code)) appliedTransforms.push('exponent');
      if (appliedTransforms.length === 0) appliedTransforms.push('minor');
    }
    if (warnings && warnings.length > 0) {
      errors.push(...warnings.slice(0, 3).map(w => `lebab: ${w.msg || w}`));
    }
  } catch (e) {
    errors.push(`lebab failed: ${e.message}`);
  }

  // Step 2: Prettier formatting
  try {
    result = await prettier.format(result, {
      parser: 'babel',
      printWidth: 100,
      tabWidth: 2,
      singleQuote: true,
      trailingComma: 'es5',
      semi: true,
      bracketSpacing: true,
      arrowParens: 'avoid',
    });
  } catch (e) {
    errors.push(`prettier failed: ${e.message}`);
    // Fall back to basic formatting if prettier fails
    try {
      result = basicFormat(result);
    } catch (e2) {
      errors.push(`basic format also failed: ${e2.message}`);
    }
  }

  return { code: result, transforms: appliedTransforms, errors };
}

/**
 * Basic formatting fallback when prettier fails (invalid syntax, etc.)
 * Just adds newlines and indentation for readability.
 */
function basicFormat(code) {
  let indent = 0;
  const lines = [];
  let current = '';
  let i = 0;

  while (i < code.length) {
    const ch = code[i];

    // Skip string literals entirely — don't break on delimiters inside them
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      current += ch;
      i++;
      while (i < code.length) {
        const c = code[i];
        current += c;
        if (c === '\\') { i++; if (i < code.length) { current += code[i]; i++; } continue; }
        if (c === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') {
      current += ch;
      lines.push('  '.repeat(indent) + current.trim());
      current = '';
      indent++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      if (current.trim()) {
        lines.push('  '.repeat(indent) + current.trim());
        current = '';
      }
      indent = Math.max(0, indent - 1);
      lines.push('  '.repeat(indent) + ch);
    } else if (ch === ';' || ch === ',') {
      current += ch;
      lines.push('  '.repeat(indent) + current.trim());
      current = '';
    } else {
      current += ch;
    }
    i++;
  }

  if (current.trim()) {
    lines.push('  '.repeat(indent) + current.trim());
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function countNewlines(str) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) count++;
  }
  return count;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

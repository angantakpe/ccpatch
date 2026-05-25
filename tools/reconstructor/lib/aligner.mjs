/**
 * Phase 3: Core alignment algorithm.
 *
 * Matches base bundle modules to target bundle modules using:
 * 1. Anchor strings (unique in both bundles → guaranteed match)
 * 2. Vote-based matching (shared strings vote for module pairs)
 * 3. Greedy assignment with topological ordering constraint
 * 4. Structural fallback for unmatched modules (normalized similarity)
 * 5. Source file attribution via source map
 */

import { buildStringIndex, findAnchorStrings } from './string-indexer.mjs';
import { fingerprintAll, jaccardSimilarity, sequenceSimilarity } from './fingerprinter.mjs';
import { createNormCache, cachedNormalizedSimilarity } from './normalizer.mjs';
import { log, verbose, elapsed } from './utils.mjs';

/** Set of chunk types that represent non-module gap code. */
const GAP_TYPES = new Set(['preamble', 'interstitial', 'entry']);
function isGapChunk(chunk) { return chunk && GAP_TYPES.has(chunk.type); }

/**
 * @typedef {Object} ModuleAlignment
 * @property {number}   baseChunkId
 * @property {number}   targetChunkId
 * @property {number}   confidence     - 0.0 to 1.0
 * @property {'exact'|'modified'|'new'|'deleted'} matchType
 * @property {string[]} sourceFiles    - attributed source file paths
 */

/**
 * @typedef {Object} AlignmentResult
 * @property {ModuleAlignment[]} alignments
 * @property {number[]} unmatchedBase    - chunk ids with no target match
 * @property {number[]} unmatchedTarget  - chunk ids with no base match
 * @property {Object}   stats
 */

/**
 * Align base and target module chunks.
 *
 * @param {import('./module-segmenter.mjs').ModuleChunk[]} baseChunks
 * @param {import('./module-segmenter.mjs').ModuleChunk[]} targetChunks
 * @param {import('./sourcemap-parser.mjs').SourceMapIndex} sourceMapIndex
 * @returns {AlignmentResult}
 */
export function alignModules(baseChunks, targetChunks, sourceMapIndex) {
  const t0 = Date.now();

  // Step 1: Build string indexes
  verbose('aligner', 'Building string indexes...');
  const baseStringIdx = buildStringIndex(baseChunks);
  const targetStringIdx = buildStringIndex(targetChunks);

  // Step 2: Find anchor strings
  verbose('aligner', 'Finding anchor strings...');
  const anchors = findAnchorStrings(baseStringIdx, targetStringIdx);

  // Step 3: Vote-based matching
  verbose('aligner', 'Running vote-based matching...');
  // Pair keys are packed as numbers: bId * targetCount + tId.
  // This avoids allocating ~1M `${bId}:${tId}` strings + split/parseInt per read.
  const targetCount = targetChunks.length;
  const votes = voteBasedMatching(baseStringIdx, targetStringIdx, targetCount);

  // Step 4: Generate fingerprints for tie-breaking
  verbose('aligner', 'Generating fingerprints...');
  const baseFps = fingerprintAll(baseChunks);
  const targetFps = fingerprintAll(targetChunks);

  // Per-chunk normalize/trigram cache: shared across positionalMatching,
  // structuralFallback, and classifyAndAttribute so each chunk is tokenized
  // and trigram-hashed at most once instead of once per (b,t) pair tested.
  const baseNorm = createNormCache(baseChunks);
  const targetNorm = createNormCache(targetChunks);

  // Step 5: Greedy assignment
  verbose('aligner', 'Running greedy assignment...');
  const { matched, unmatchedBase, unmatchedTarget } = greedyAssign(
    votes, anchors, baseFps, targetFps, baseChunks, targetChunks, targetCount
  );

  // Step 6: Structural fallback for unmatched
  verbose('aligner', `Structural fallback for ${unmatchedBase.length} base, ${unmatchedTarget.length} target unmatched...`);
  const fallbackMatches = structuralFallback(
    unmatchedBase, unmatchedTarget, baseChunks, targetChunks, baseFps, targetFps, baseNorm, targetNorm
  );

  // Step 6b: Positional matching for string-less modules
  // Modules with 0-1 strings can't be matched by strings but esbuild preserves
  // topological order, so we match by ordinal position within type (factory/lazy)
  const afterStructural = new Set([
    ...unmatchedBase.filter(id => !fallbackMatches.some(fm => fm.baseChunkId === id)),
  ]);
  const afterStructuralTarget = new Set([
    ...unmatchedTarget.filter(id => !fallbackMatches.some(fm => fm.targetChunkId === id)),
  ]);

  verbose('aligner', `Positional matching for ${afterStructural.size} base, ${afterStructuralTarget.size} target remaining...`);
  const positionalMatches = positionalMatching(
    afterStructural, afterStructuralTarget, baseChunks, targetChunks, baseFps, targetFps, baseNorm, targetNorm
  );

  // Merge results
  const allMatched = [...matched, ...fallbackMatches, ...positionalMatches];
  const finalUnmatchedBase = new Set(afterStructural);
  const finalUnmatchedTarget = new Set(afterStructuralTarget);
  for (const fm of fallbackMatches) {
    finalUnmatchedBase.delete(fm.baseChunkId);
    finalUnmatchedTarget.delete(fm.targetChunkId);
  }
  for (const pm of positionalMatches) {
    finalUnmatchedBase.delete(pm.baseChunkId);
    finalUnmatchedTarget.delete(pm.targetChunkId);
  }

  // Step 7: Classify match types and attribute source files
  verbose('aligner', 'Classifying matches and attributing source files...');
  const alignments = classifyAndAttribute(
    allMatched, baseChunks, targetChunks, baseFps, targetFps, sourceMapIndex, baseNorm, targetNorm
  );

  // Step 8: Rename detection — match deleted modules to new modules by content similarity.
  // If a source file was renamed/moved between versions, its modules appear as "deleted"
  // in the base and "new" in the target. We try to recover these by comparing fingerprints.
  const deletedBaseIds = [...finalUnmatchedBase].filter(id => !isGapChunk(baseChunks[id]));
  const newTargetIds = [...finalUnmatchedTarget].filter(id => !isGapChunk(targetChunks[id]));

  verbose('aligner', `Rename detection: ${deletedBaseIds.length} deleted vs ${newTargetIds.length} new...`);
  const renameMatches = [];
  if (deletedBaseIds.length > 0 && newTargetIds.length > 0) {
    const renameCandidates = [];
    for (const bId of deletedBaseIds) {
      for (const tId of newTargetIds) {
        if (baseChunks[bId].type !== targetChunks[tId].type) continue;
        const sizeRatio = baseFps[bId].codeLength / Math.max(1, targetFps[tId].codeLength);
        if (sizeRatio < 0.4 || sizeRatio > 2.5) continue;
        const jaccard = jaccardSimilarity(baseFps[bId], targetFps[tId]);
        if (jaccard > 0.5) {
          renameCandidates.push({ bId, tId, score: jaccard });
        }
      }
    }
    renameCandidates.sort((a, b) => b.score - a.score);
    const renamedBase = new Set();
    const renamedTarget = new Set();
    for (const { bId, tId, score } of renameCandidates) {
      if (renamedBase.has(bId) || renamedTarget.has(tId)) continue;
      renameMatches.push({ baseChunkId: bId, targetChunkId: tId, score });
      renamedBase.add(bId);
      renamedTarget.add(tId);
      finalUnmatchedBase.delete(bId);
      finalUnmatchedTarget.delete(tId);
    }
    if (renameMatches.length > 0) {
      const renameAlignments = classifyAndAttribute(
        renameMatches, baseChunks, targetChunks, baseFps, targetFps, sourceMapIndex, baseNorm, targetNorm
      );
      // Mark these as renamed so the reconstructor knows the source file may have moved
      for (const ra of renameAlignments) {
        ra.renamed = true;
        alignments.push(ra);
      }
      verbose('aligner', `  Rename detection: ${renameMatches.length} recovered matches`);
    }
  }

  // Add deleted/new entries (skip gap chunks)
  for (const baseId of finalUnmatchedBase) {
    if (isGapChunk(baseChunks[baseId])) continue;
    const srcFiles = attributeSourceFiles(baseChunks[baseId], sourceMapIndex);
    alignments.push({
      baseChunkId: baseId,
      targetChunkId: -1,
      confidence: 0,
      matchType: 'deleted',
      sourceFiles: srcFiles,
    });
  }
  for (const targetId of finalUnmatchedTarget) {
    if (isGapChunk(targetChunks[targetId])) continue;
    alignments.push({
      baseChunkId: -1,
      targetChunkId: targetId,
      confidence: 0,
      matchType: 'new',
      sourceFiles: [],
    });
  }

  const stats = {
    totalBase: baseChunks.length,
    totalTarget: targetChunks.length,
    matched: allMatched.length + renameMatches.length,
    exact: alignments.filter(a => a.matchType === 'exact').length,
    modified: alignments.filter(a => a.matchType === 'modified').length,
    renamed: renameMatches.length,
    deleted: [...finalUnmatchedBase].filter(id => !isGapChunk(baseChunks[id])).length,
    new: [...finalUnmatchedTarget].filter(id => !isGapChunk(targetChunks[id])).length,
    anchorCount: anchors.size,
  };

  log('aligner', `Alignment complete in ${elapsed(t0)}`);
  log('aligner', `  Matched: ${stats.matched} (${stats.exact} exact, ${stats.modified} modified, ${stats.renamed} renamed)`);
  log('aligner', `  Deleted: ${stats.deleted}, New: ${stats.new}`);

  return {
    alignments,
    unmatchedBase: [...finalUnmatchedBase],
    unmatchedTarget: [...finalUnmatchedTarget],
    stats,
  };
}

/**
 * Vote-based matching: each shared string votes for a (base, target) module pair.
 * Strings in fewer chunks get higher weight (more discriminative).
 */
function voteBasedMatching(baseIdx, targetIdx, targetCount) {
  const votes = new Map(); // key: bId * targetCount + tId → count

  for (const [value, baseEntries] of baseIdx.forward) {
    const targetEntries = targetIdx.forward.get(value);
    if (!targetEntries) continue;

    const baseChunkIds = [...new Set(baseEntries.map(e => e.chunkId))];
    const targetChunkIds = [...new Set(targetEntries.map(e => e.chunkId))];

    // Skip strings that appear in too many chunks on either side — they're
    // too common to be discriminative (e.g., "error", "name", "data")
    if (baseChunkIds.length > 10 || targetChunkIds.length > 10) continue;

    // Weight by discriminativeness — strings in fewer chunks are more valuable
    const spread = baseChunkIds.length * targetChunkIds.length;
    const weight = 1 / spread; // unique strings get weight=1, shared get less

    for (const bId of baseChunkIds) {
      const rowBase = bId * targetCount;
      for (const tId of targetChunkIds) {
        const key = rowBase + tId;
        votes.set(key, (votes.get(key) || 0) + weight);
      }
    }
  }

  return votes;
}

/**
 * Greedy assignment: accept highest-score pairs first.
 * NOTE: no ordering constraint is enforced — pairs are matched purely by
 * descending score. Ordering constraints are handled in positionalMatching
 * for modules that survive unmatched through this phase.
 */
function greedyAssign(votes, anchors, baseFps, targetFps, baseChunks, targetChunks, targetCount) {
  // Build candidate list from votes + anchors. Keys are packed numbers
  // (bId * targetCount + tId) — unpack as `tId = key % targetCount;
  // bId = (key - tId) / targetCount` (integer division without Math.floor).
  const candidates = new Map(); // key (number) → score

  // Anchors get a strong bonus
  const anchorPairCounts = new Map();
  for (const [, { baseChunkId, targetChunkId }] of anchors) {
    const key = baseChunkId * targetCount + targetChunkId;
    anchorPairCounts.set(key, (anchorPairCounts.get(key) || 0) + 1);
  }

  // Combine vote scores with anchor bonuses and fingerprint similarity
  for (const [key, voteCount] of votes) {
    const tId = key % targetCount;
    const bId = (key - tId) / targetCount;

    // Skip gap chunks — they're handled separately
    if (isGapChunk(baseChunks[bId]) || isGapChunk(targetChunks[tId])) continue;

    const anchorBonus = (anchorPairCounts.get(key) || 0) * 10;
    const jaccard = jaccardSimilarity(baseFps[bId], targetFps[tId]);

    const score = voteCount + anchorBonus + jaccard * 5;
    candidates.set(key, score);
  }

  // Also add pure anchor matches that might not appear in votes
  for (const [key, count] of anchorPairCounts) {
    if (!candidates.has(key)) {
      const tId = key % targetCount;
      const bId = (key - tId) / targetCount;
      if (isGapChunk(baseChunks[bId]) || isGapChunk(targetChunks[tId])) continue;
      const jaccard = jaccardSimilarity(baseFps[bId], targetFps[tId]);
      candidates.set(key, count * 10 + jaccard * 5);
    }
  }

  // Sort by score descending
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);

  const matchedBase = new Set();
  const matchedTarget = new Set();
  const matched = [];

  // Minimum score gate: pairs below this threshold are left unmatched
  // rather than forced into a bad alignment. A score of 2.0 requires
  // meaningful evidence (e.g. at least a couple of shared strings or
  // an anchor match) — a single common string alone is not enough.
  const MIN_GREEDY_SCORE = 1.0;

  for (const [key, score] of sorted) {
    if (score < MIN_GREEDY_SCORE) break; // sorted descending, no further pairs will qualify
    const tId = key % targetCount;
    const bId = (key - tId) / targetCount;
    if (matchedBase.has(bId) || matchedTarget.has(tId)) continue;

    matched.push({ baseChunkId: bId, targetChunkId: tId, score });
    matchedBase.add(bId);
    matchedTarget.add(tId);
  }

  // Find unmatched (excluding gap chunks)
  const unmatchedBase = baseChunks
    .filter(c => !isGapChunk(c) && !matchedBase.has(c.id))
    .map(c => c.id);
  const unmatchedTarget = targetChunks
    .filter(c => !isGapChunk(c) && !matchedTarget.has(c.id))
    .map(c => c.id);

  verbose('aligner', `  Greedy: ${matched.length} pairs from ${sorted.length} candidates`);

  return { matched, unmatchedBase, unmatchedTarget };
}

/**
 * Positional matching: match unmatched modules by their ordinal position
 * within type (factory/lazy). esbuild preserves topological module order,
 * so factory #N in base likely corresponds to factory #N in target.
 *
 * We verify each positional candidate with normalized code similarity
 * to avoid false matches from insertions/deletions.
 */
function positionalMatching(unmatchedBaseIds, unmatchedTargetIds, baseChunks, targetChunks, baseFps, targetFps, baseNorm, targetNorm) {
  const results = [];

  for (const type of ['factory', 'lazy']) {
    // Get ordinal position → chunk id mappings for unmatched modules of this type
    // Ordinal = position among ALL modules of this type (not just unmatched)
    const baseByOrdinal = new Map();
    const targetByOrdinal = new Map();

    // Build ordinal maps for all modules, then filter to unmatched
    let baseOrd = 0;
    for (const c of baseChunks) {
      if (c.type === type) {
        if (unmatchedBaseIds.has(c.id)) baseByOrdinal.set(baseOrd, c.id);
        baseOrd++;
      }
    }

    let targetOrd = 0;
    for (const c of targetChunks) {
      if (c.type === type) {
        if (unmatchedTargetIds.has(c.id)) targetByOrdinal.set(targetOrd, c.id);
        targetOrd++;
      }
    }

    // Dynamically size the search window based on how many modules were added/removed
    const ordinalDelta = Math.abs(baseByOrdinal.size - targetByOrdinal.size);
    const windowSize = Math.max(20, ordinalDelta + 10);

    // Try to match by same ordinal position within window
    const matchedBase = new Set();
    const matchedTarget = new Set();

    for (const [ord, bId] of baseByOrdinal) {
      if (matchedBase.has(bId)) continue;

      let bestTId = -1;
      let bestSim = 0.3; // minimum threshold

      for (let delta = 0; delta <= windowSize; delta++) {
        for (const d of (delta === 0 ? [0] : [-delta, delta])) {
          const tId = targetByOrdinal.get(ord + d);
          if (tId === undefined || matchedTarget.has(tId)) continue;

          // Quick size check — modules should be similar size (2:1 max ratio)
          const sizeRatio = baseFps[bId].codeLength / Math.max(1, targetFps[tId].codeLength);
          if (sizeRatio < 0.5 || sizeRatio > 2.0) continue;

          // For modules with some strings, check Jaccard
          const jaccard = jaccardSimilarity(baseFps[bId], targetFps[tId]);

          let sim;
          if (baseFps[bId].stringCount > 0) {
            const sizeSim = 1 - Math.abs(baseFps[bId].codeLength - targetFps[tId].codeLength) /
              Math.max(baseFps[bId].codeLength, targetFps[tId].codeLength);
            sim = Math.max(jaccard, sizeSim * 0.5);
          } else {
            // Stringless modules: use normalized code similarity (token-based), not just size
            sim = cachedNormalizedSimilarity(baseNorm, bId, targetNorm, tId);
          }

          // Prefer closer ordinal matches (decay by distance)
          const distancePenalty = delta / (windowSize * 2);
          const adjustedSim = sim - distancePenalty;

          if (adjustedSim > bestSim) {
            bestSim = adjustedSim;
            bestTId = tId;
          }
        }
        // Early exit if we found a very good match
        if (bestSim > 0.9) break;
      }

      if (bestTId >= 0) {
        results.push({ baseChunkId: bId, targetChunkId: bestTId, score: bestSim });
        matchedBase.add(bId);
        matchedTarget.add(bestTId);
      }
    }
  }

  verbose('aligner', `  Positional matching: ${results.length} additional matches`);
  return results;
}

/**
 * Structural fallback: for unmatched modules, use normalized code similarity.
 */
function structuralFallback(unmatchedBaseIds, unmatchedTargetIds, baseChunks, targetChunks, baseFps, targetFps, baseNorm, targetNorm) {
  const results = [];
  if (unmatchedBaseIds.length === 0 || unmatchedTargetIds.length === 0) return results;

  const matchedBase = new Set();
  const matchedTarget = new Set();

  // First pass: modules WITH strings — fingerprint similarity
  const candidates = [];
  const stringlessBase = [];
  const stringlessTarget = [];

  for (const bId of unmatchedBaseIds) {
    if (baseFps[bId].stringCount === 0) { stringlessBase.push(bId); continue; }
    for (const tId of unmatchedTargetIds) {
      if (targetFps[tId].stringCount === 0) continue;
      const jaccard = jaccardSimilarity(baseFps[bId], targetFps[tId]);
      if (jaccard > 0.3) {
        candidates.push({ bId, tId, score: jaccard });
      }
    }
  }
  for (const tId of unmatchedTargetIds) {
    if (targetFps[tId].stringCount === 0) stringlessTarget.push(tId);
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const { bId, tId, score } of candidates) {
    if (matchedBase.has(bId) || matchedTarget.has(tId)) continue;

    let confidence = score;
    if (score < 0.7) {
      const normSim = cachedNormalizedSimilarity(baseNorm, bId, targetNorm, tId);
      confidence = (score + normSim) / 2;
    }

    if (confidence >= 0.40) {
      results.push({ baseChunkId: bId, targetChunkId: tId, score: confidence });
      matchedBase.add(bId);
      matchedTarget.add(tId);
    }
  }

  // Second pass: stringless modules — use normalized code similarity (token-based)
  // Size alone can't distinguish unrelated modules, so we tokenize and compare.
  // Group by type and match within type.
  const slCandidates = [];
  for (const bId of stringlessBase) {
    if (matchedBase.has(bId)) continue;
    for (const tId of stringlessTarget) {
      if (matchedTarget.has(tId)) continue;
      if (baseChunks[bId].type !== targetChunks[tId].type) continue;
      // Quick size pre-filter (2:1 ratio) before expensive normalization
      const sizeRatio = baseFps[bId].codeLength / Math.max(1, targetFps[tId].codeLength);
      if (sizeRatio < 0.5 || sizeRatio > 2.0) continue;
      const normSim = cachedNormalizedSimilarity(baseNorm, bId, targetNorm, tId);
      if (normSim > 0.4) {
        slCandidates.push({ bId, tId, score: normSim });
      }
    }
  }
  slCandidates.sort((a, b) => b.score - a.score);
  for (const { bId, tId, score } of slCandidates) {
    if (matchedBase.has(bId) || matchedTarget.has(tId)) continue;
    results.push({ baseChunkId: bId, targetChunkId: tId, score });
    matchedBase.add(bId);
    matchedTarget.add(tId);
  }

  verbose('aligner', `  Structural fallback: ${results.length} additional matches`);
  return results;
}

/**
 * Classify matches as exact/modified and attribute source files.
 */
function classifyAndAttribute(matches, baseChunks, targetChunks, baseFps, targetFps, sourceMapIndex, baseNorm, targetNorm) {
  return matches.map(m => {
    const baseFp = baseFps[m.baseChunkId];
    const targetFp = targetFps[m.targetChunkId];

    // Compute fine-grained similarity for classification
    const seqSim = sequenceSimilarity(baseFp, targetFp);
    const jaccard = jaccardSimilarity(baseFp, targetFp);

    const bothStringless = baseFp.stringCount === 0 && targetFp.stringCount === 0;

    let confidence, matchType;
    if (bothStringless) {
      // No strings to compare — use normalized code similarity (token-based)
      // instead of just size, which can't distinguish unrelated modules
      const normSim = cachedNormalizedSimilarity(baseNorm, m.baseChunkId, targetNorm, m.targetChunkId);
      confidence = normSim;
      matchType = normSim >= 0.95 ? 'exact' : 'modified';
    } else {
      confidence = Math.max(seqSim, jaccard);
      matchType = seqSim >= 0.98 ? 'exact' : 'modified';
    }

    // Attribute source files
    const sourceFiles = attributeSourceFiles(baseChunks[m.baseChunkId], sourceMapIndex);

    return {
      baseChunkId: m.baseChunkId,
      targetChunkId: m.targetChunkId,
      confidence,
      matchType,
      sourceFiles,
    };
  });
}

/**
 * Determine which source files a base chunk maps to using the source map.
 * Uses binary search to find mappings within the chunk's generated line range.
 */
function attributeSourceFiles(baseChunk, sourceMapIndex) {
  if (!sourceMapIndex || !baseChunk) return [];

  const sourceFiles = new Set();
  const mappings = sourceMapIndex.allMappings;

  // The chunk's line is 1-based, source map genLine is 0-based
  const startGenLine = baseChunk.line - 1;
  const endGenLine = baseChunk.endLine - 1;

  // Binary search for the first mapping at or after startGenLine
  let lo = 0, hi = mappings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (mappings[mid].genLine < startGenLine) lo = mid + 1;
    else hi = mid - 1;
  }

  // Scan forward from lo until we pass endGenLine
  for (let i = lo; i < mappings.length; i++) {
    const m = mappings[i];
    if (m.genLine > endGenLine) break;
    const src = sourceMapIndex.sources[m.sourceIndex];
    if (src && src.path.includes('/src/')) {
      const normalized = src.path.replace(/^\.\.\//, '');
      sourceFiles.add(normalized);
    }
  }

  return [...sourceFiles];
}

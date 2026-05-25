import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPatch, structuredPatch, applyPatch } from 'diff';
import { validateManifest } from './manifest.mjs';
import { fuzzyMatch } from './anchors.mjs';
import { resolveAt } from './at-selector.mjs';
import { compileKind } from './patch-kinds.mjs';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const PHASE_ORDER = { pre: 0, main: 1, post: 2 };

function phaseOf(patch) {
  return patch?.phase ?? 'main';
}

function toList(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
}

/**
 * Run a verify block against post-apply code. Returns an array of failure
 * descriptions (empty when all assertions pass). Supports:
 *   verify.present  string|string[]   — substrings that MUST exist.
 *   verify.absent   string|string[]   — substrings that MUST NOT exist.
 *   verify.count    number | { present?, absent? }
 *                                     — exact totals across all present/absent strings.
 */
export function checkVerify(verify, code) {
  const issues = [];
  const presents = toList(verify.present);
  const absents  = toList(verify.absent);

  for (const s of presents) {
    if (!code.includes(s)) issues.push(`expected present: ${s.slice(0, 60)}`);
  }
  for (const s of absents) {
    if (code.includes(s)) issues.push(`expected absent: ${s.slice(0, 60)}`);
  }

  if (verify.count !== undefined && verify.count !== null) {
    const c = typeof verify.count === 'number' ? { present: verify.count } : verify.count;
    if (typeof c.present === 'number') {
      const total = presents.reduce((n, s) => n + countOccurrences(code, s), 0);
      if (total !== c.present) {
        issues.push(`expected count.present=${c.present}, actual=${total} (across ${presents.length} string(s))`);
      }
    }
    if (typeof c.absent === 'number') {
      const total = absents.reduce((n, s) => n + countOccurrences(code, s), 0);
      if (total !== c.absent) {
        issues.push(`expected count.absent=${c.absent}, actual=${total} (across ${absents.length} string(s))`);
      }
    }
  }

  return issues;
}

// Tiny dotted-numeric comparator for CC versions like "2.1.148".
// Returns -1 | 0 | 1, or null if either input doesn't parse.
function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const pa = a.split('.').map(n => Number.parseInt(n, 10));
  const pb = b.split('.').map(n => Number.parseInt(n, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function resolvePatchNames(patches, requestedPatches) {
  if (!requestedPatches.length) return [];
  if (requestedPatches.includes('all')) return Object.keys(patches);
  return requestedPatches;
}

export function topoSort(names, patches) {
  const visited = new Set();
  const result = [];
  const enabledSet = new Set(names);
  function visit(name, chain = []) {
    if (visited.has(name)) return;
    if (chain.includes(name)) {
      const cycle = [...chain.slice(chain.indexOf(name)), name].join(' -> ');
      throw new Error(`Circular patch dependency: ${cycle}`);
    }
    const nextChain = [...chain, name];
    const patch = patches[name];
    const deps = (patch && patch.dependsOn) ? patch.dependsOn : [];
    for (const dep of deps) {
      if (!patches[dep]) {
        throw new Error(`Patch "${name}" declares dependsOn "${dep}", but no such patch is loaded. Check for typos in core/ or extensions/.`);
      }
      if (!enabledSet.has(dep)) {
        throw new Error(`Patch "${name}" requires "${dep}", but "${dep}" is not enabled. Enable "${dep}" in ccpatch.yml or remove it from "${name}"'s dependsOn.`);
      }
      visit(dep, nextChain);
    }
    visited.add(name);
    result.push(name);
  }
  for (const name of names) visit(name);
  return result;
}

/**
 * Convert a structuredPatch into approximate byte ranges in the *pre-apply*
 * code. We currently use line resolution: each hunk produces one range
 * spanning from the start of `oldStart` to the start of `oldStart + oldLines`.
 * That's imperfect — a small edit inside a long line produces a too-wide span —
 * but it's a sane first approximation. A future revision can compute
 * byte-exact spans by diffing within hunks.
 */
function diffSpansFromPatch(preCode, sp) {
  const ranges = [];
  if (!sp || !Array.isArray(sp.hunks)) return ranges;
  // Build a line-start index once.
  const lineStarts = [0];
  for (let i = 0; i < preCode.length; i++) {
    if (preCode.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
  }
  const lineOffset = (lineNum1) => {
    const idx = Math.max(0, Math.min(lineStarts.length - 1, lineNum1 - 1));
    return lineStarts[idx];
  };
  for (const h of sp.hunks) {
    const start = lineOffset(h.oldStart);
    const endLine = h.oldStart + (h.oldLines || 0);
    const end = endLine >= lineStarts.length ? preCode.length : lineOffset(endLine);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

function rangesIntersect(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Detect overlap conflicts among patches that ran in the same phase.
 *   trace: array of { name, phase, atSitesOriginal, diffSpansPre, preCodeLen, allowOverlapWith }
 * Where:
 *   atSitesOriginal — atSites recorded in the code state immediately before
 *                     this patch applied (post-previous-patches code state).
 *   diffSpansPre    — byte ranges in the pre-apply code that the patch touched.
 *
 * Returns array of conflicts: { phase, a, b, kind, rangeA, rangeB }.
 *
 * Note: because each patch sees a different code state, "comparing ranges
 * across patches" is approximate. We compare A's diff span (in A's preCode) to
 * B's at/diff span (in B's preCode = post-A code). Offsets shift by the net
 * delta A introduced; we don't correct for that. The check is a smell detector,
 * not a proof — false positives are possible when ranges incidentally align.
 */
function detectOverlapsInPhase(traces) {
  const conflicts = [];
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const A = traces[i];
      const B = traces[j];
      // at-vs-at: compare resolved sites (in their respective code states).
      if (A.atSites && B.atSites) {
        for (const sa of A.atSites) {
          for (const sb of B.atSites) {
            if (rangesIntersect([sa.start, sa.end || sa.start + 1], [sb.start, sb.end || sb.start + 1])) {
              conflicts.push({
                phase: A.phase, a: A.name, b: B.name, kind: 'at-vs-at',
                rangeA: [sa.start, sa.end ?? sa.start],
                rangeB: [sb.start, sb.end ?? sb.start],
              });
            }
          }
        }
      }
      // at-vs-diff: B's resolved at-sites intersect A's diff span.
      if (B.atSites && A.diffSpans) {
        for (const sb of B.atSites) {
          for (const ra of A.diffSpans) {
            if (rangesIntersect(ra, [sb.start, sb.end || sb.start + 1])) {
              conflicts.push({
                phase: A.phase, a: A.name, b: B.name, kind: 'at-vs-diff',
                rangeA: ra,
                rangeB: [sb.start, sb.end ?? sb.start],
              });
            }
          }
        }
      }
      // diff-vs-diff: both patches touched overlapping byte ranges (approx).
      if (A.diffSpans && B.diffSpans) {
        for (const ra of A.diffSpans) {
          for (const rb of B.diffSpans) {
            if (rangesIntersect(ra, rb)) {
              conflicts.push({
                phase: A.phase, a: A.name, b: B.name, kind: 'diff-vs-diff',
                rangeA: ra, rangeB: rb,
              });
            }
          }
        }
      }
    }
  }
  return conflicts;
}

/**
 * Lifecycle hooks (optional, declared on the patch module):
 *
 *   onBeforeApply(ctx)  — called before resolveAt/compileKind/apply. May mutate
 *                          ctx.opts (the per-invocation patchOptions) or ctx.code.
 *   onAfterApply(ctx)   — called after apply() (and any fallback-diff) returns.
 *                          May mutate ctx.appliedCode for last-mile fixups.
 *   onVerifyFail(ctx)   — called when checkVerify() finds issues. Return a string
 *                          to re-run verify against that string (one retry max);
 *                          return undefined/anything else to give up.
 *
 * ctx is a single per-patch object reused across all hook invocations. Fields:
 *   name, phase, code, appliedCode, opts, verify.issues, attempt, logger.
 * Hook errors are logged ([hook] <name>.<hookName>) and treated as the
 * surrounding step's failure (apply throw / verify fail). Not swallowed.
 * Each hook fire writes one JSONL entry to storage/outputs/patch-lifecycle.jsonl.
 */
async function fireHook(patch, hookName, ctx, logger) {
  const fn = patch[hookName];
  if (typeof fn !== 'function') return { ok: true, result: undefined };
  const start = Date.now();
  const beforeLen = (typeof ctx.appliedCode === 'string') ? ctx.appliedCode.length
                  : (typeof ctx.code === 'string') ? ctx.code.length : 0;
  let entry = {
    ts: new Date().toISOString(),
    patch: ctx.name,
    hook: hookName,
    attempt: ctx.attempt,
    phase: ctx.phase,
  };
  try {
    const result = await fn(ctx);
    const afterLen = (typeof ctx.appliedCode === 'string') ? ctx.appliedCode.length
                   : (typeof ctx.code === 'string') ? ctx.code.length : 0;
    entry.byteDelta = afterLen - beforeLen;
    entry.durationMs = Date.now() - start;
    writeLifecycleEntry(entry);
    return { ok: true, result };
  } catch (err) {
    entry.durationMs = Date.now() - start;
    entry.error = err && err.message ? err.message : String(err);
    writeLifecycleEntry(entry);
    logger.error(`  [hook] ${ctx.name}.${hookName} threw: ${entry.error}`);
    return { ok: false, error: err };
  }
}

function writeLifecycleEntry(entry) {
  try {
    mkdirSync('storage/outputs', { recursive: true });
    appendFileSync(join('storage/outputs', 'patch-lifecycle.jsonl'),
                   JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) { /* non-fatal */ }
}

/**
 * Inject a `__ccpCovHit('<marker>')` call into the post-apply code so this
 * patch's runtime coverage can be tracked. Best-effort:
 *   1. If the patch resolved an @At HEAD/AFTER/BEFORE/INVOKE site, splice the
 *      call immediately at that site in the post-apply code (mapped by line
 *      content match — atSites point into the pre-apply code).
 *   2. Otherwise, prepend the call onto the first inserted line of the diff.
 *   3. Otherwise, return null to signal "no place to instrument" — the runner
 *      logs a notice and proceeds.
 *
 * Returns the modified code string on success or null on skip.
 */
function injectCoverageHit(preCode, postCode, marker, atSites) {
  if (!marker || typeof postCode !== 'string') return null;
  const hitCall = `(globalThis.__ccpCovHit&&globalThis.__ccpCovHit(${JSON.stringify(marker)}));`;
  // Strategy 1: anchor in the post-apply diff. Find the first hunk of inserted
  // text (a line present in postCode but not preCode) and prepend the call.
  try {
    const sp = structuredPatch('a', 'b', preCode, postCode, '', '', { context: 0 });
    for (const h of sp.hunks || []) {
      for (const ln of h.lines || []) {
        if (ln.startsWith('+') && ln.length > 1) {
          const insertedLine = ln.slice(1);
          // Skip pure-whitespace inserts; we want real code to wrap.
          if (!insertedLine.trim()) continue;
          const idx = postCode.indexOf(insertedLine);
          if (idx !== -1) {
            return postCode.slice(0, idx) + hitCall + postCode.slice(idx);
          }
        }
      }
    }
  } catch (_) { /* fall through */ }
  // Strategy 2: at-site fallback (atSites refer to preCode offsets, but if
  // postCode === preCode + injection that didn't show up in the diff, this
  // still produces a runnable hit). Splice into postCode at the same offset
  // when possible.
  if (Array.isArray(atSites) && atSites.length > 0) {
    const site = atSites[0];
    const off = typeof site.start === 'number' ? site.start : null;
    if (off !== null && off <= postCode.length) {
      return postCode.slice(0, off) + hitCall + postCode.slice(off);
    }
  }
  return null;
}

export async function applyNamedPatches(code, patches, patchNames, logger = console, patchOptions = {}) {
  let nextCode = code;
  const results = {};
  const globalStrict = patchOptions.strict === true;
  const failures = [];
  // Per-phase trace for overlap detection.
  const phaseTraces = { pre: [], main: [], post: [] };

  const topoOrdered = topoSort(patchNames, patches);

  // Enforce phase-respecting dependencies: a patch may only depend on patches
  // in the same or an earlier phase. (pre < main < post)
  for (const name of topoOrdered) {
    const patch = patches[name];
    if (!patch) continue;
    const phaseIdx = PHASE_ORDER[phaseOf(patch)];
    for (const dep of patch.dependsOn ?? []) {
      const depIdx = PHASE_ORDER[phaseOf(patches[dep])];
      if (depIdx > phaseIdx) {
        throw new Error(
          `Patch "${name}" (phase="${phaseOf(patch)}") depends on "${dep}" (phase="${phaseOf(patches[dep])}"), ` +
          `which runs in a later phase. Cross-phase deps must point to same-or-earlier phases.`
        );
      }
    }
  }

  // Composite stable sort: (1) phase, (2) topo position, (3) priority asc.
  // Topo is authoritative for ordering deps; priority only orders peers without
  // a dependency relationship. Map name → topo index for tie-breaking peers
  // that survive the phase split.
  const topoIndex = new Map(topoOrdered.map((n, i) => [n, i]));
  const priorityOf = (name) => {
    const p = patches[name];
    if (!p) return 1000;
    return Number.isInteger(p.priority) ? p.priority : 1000;
  };
  // Use topoOrdered as the base, then partition by (phase, priority) while
  // preserving topo order for ties. We sort with a synthetic key that splits
  // peers (nodes with no transitive dep edge between them) by priority. Since
  // we can't cheaply compute reachability here, we approximate: within a phase,
  // group by topo strata as defined by the topo order, then sort each phase
  // bucket by (priority, original topo index). This is stable enough that a
  // dependent never precedes its dependency (topoSort guarantees the input is
  // already valid), because within one phase a B that dependsOn A had to appear
  // after A in topoOrdered — but a lower-priority B could float past A.
  // Guard against that: when sorting, if B depends (transitively) on A, B must
  // stay after A regardless of priority.
  const transDeps = new Map(); // name → Set of names it (transitively) depends on
  function depsOf(name) {
    if (transDeps.has(name)) return transDeps.get(name);
    const out = new Set();
    const stack = [...((patches[name] && patches[name].dependsOn) || [])];
    while (stack.length) {
      const d = stack.pop();
      if (out.has(d)) continue;
      out.add(d);
      const dp = patches[d];
      if (dp && Array.isArray(dp.dependsOn)) {
        for (const dd of dp.dependsOn) if (!out.has(dd)) stack.push(dd);
      }
    }
    transDeps.set(name, out);
    return out;
  }
  const ordered = topoOrdered.slice().sort((a, b) => {
    const pa = PHASE_ORDER[phaseOf(patches[a])];
    const pb = PHASE_ORDER[phaseOf(patches[b])];
    if (pa !== pb) return pa - pb;
    // Same phase: respect dependency edges first.
    if (depsOf(a).has(b)) return 1;  // a depends on b → b first
    if (depsOf(b).has(a)) return -1; // b depends on a → a first
    const prA = priorityOf(a), prB = priorityOf(b);
    if (prA !== prB) return prA - prB;
    // Stable fallback: original topo position.
    return topoIndex.get(a) - topoIndex.get(b);
  });

  for (const name of ordered) {
    const patch = patches[name];
    if (!patch) {
      logger.warn(`  [!] Patch not found: ${name} (skipping)`);
      results[name] = 'skipped';
      continue;
    }

    const patchStrict = globalStrict || patch.required === true;
    const fail = (reason) => {
      const msg = `${name}: ${reason}`;
      if (patchStrict) failures.push(msg);
    };

    // Validate manifest — missing verify or preload inconsistencies are fatal.
    const variant = patch.__resolvedVariant ?? 'default';
    const { ok: manifestOk, errors: manifestErrors, normalized } = validateManifest(patch, name + '.mjs', { variant });
    if (!manifestOk) {
      logger.error(`  [!] Manifest errors for "${name}": ${manifestErrors.join('; ')}`);
      results[name] = 'skipped';
      fail(`manifest invalid (${manifestErrors.join('; ')})`);
      continue;
    }
    logger.log(`  [+] Applying: ${name} - ${patch.description}`);

    // Revisit marker: nudge the maintainer when a forensic patch has reached
    // the upstream version it was supposed to be re-evaluated at.
    if (normalized.revisit && normalized.revisit.until && patchOptions.version) {
      const cmp = compareVersions(patchOptions.version, normalized.revisit.until);
      if (cmp !== null && cmp >= 0) {
        const added = normalized.revisit.addedIn ? ` (added in v${normalized.revisit.addedIn})` : '';
        logger.warn(`  [revisit] ${name}${added}: re-evaluate at v${normalized.revisit.until} — ${normalized.revisit.note}`);
      }
    }

    // Per-patch lifecycle context — same object every hook fire.
    const lifecycleCtx = {
      name,
      phase: phaseOf(patch),
      code: nextCode,
      appliedCode: null,
      opts: { ...patchOptions },
      verify: { issues: [] },
      attempt: 1,
      logger,
    };

    // onBeforeApply: patch may mutate ctx.opts or ctx.code.
    {
      const hookRes = await fireHook(patch, 'onBeforeApply', lifecycleCtx, logger);
      if (!hookRes.ok) {
        results[name] = 'error';
        fail(`onBeforeApply threw: ${hookRes.error.message}`);
        continue;
      }
    }
    const beforeOpts = lifecycleCtx.opts;
    const beforeCode = lifecycleCtx.code;

    // Resolve @At selector (if declared) before calling apply().
    let atSites = null;
    if (normalized.at) {
      const resolved = resolveAt(normalized.at, beforeCode, beforeOpts);
      if (!resolved.ok) {
        logger.error(`  [!] @At resolution failed for "${name}": ${resolved.error}`);
        if (resolved.candidates && resolved.candidates.length > 0) {
          for (const c of resolved.candidates) {
            logger.warn(`      Candidate (score ${c.score.toFixed(2)}): \`${c.snippet.slice(0, 80)}\` at offset ${c.offset}`);
          }
        }
        results[name] = 'error';
        fail(`@At: ${resolved.error}`);
        continue;
      }
      atSites = resolved.sites;
    }

    try {
      const _patchStart = Date.now();
      const preCode = beforeCode;
      // For declarative kinds (prefix/postfix/transpiler), synthesize apply()
      // from the manifest. Free-kind patches use their own apply unchanged.
      const applyFn = (normalized.kind && normalized.kind !== 'free')
        ? compileKind(patch)
        : patch.apply;
      const callOpts = atSites ? { ...beforeOpts, atSites } : beforeOpts;
      const appliedCode = applyFn(preCode, callOpts);
      const _patchMs = Date.now() - _patchStart;
      if (_patchMs > 5000) {
        logger.warn(`  [!] SLOW PATCH: "${name}" took ${_patchMs}ms — check for catastrophic regex backtracking`);
      } else if (_patchMs > 1000) {
        logger.log(`  [~] ${name}: ${_patchMs}ms`);
      }
      if (typeof appliedCode !== 'string') {
        logger.error(`  [!] Patch "${name}" returned non-string (${typeof appliedCode}) — keeping code unchanged`);
        results[name] = 'error';
        fail(`apply() returned non-string (${typeof appliedCode})`);
      } else {
        const noChange = appliedCode === preCode;
        // A patch with only `verify.absent` describes a *desired end state*, not
        // a transformation — if the bad string is already absent upstream, the
        // correct outcome is no-change. Only flag no-change as drift when the
        // patch lacks a verify (it must have transformed something) or declares
        // `verify.present` (it had a positive thing to inject).
        const hasOnlyAbsentVerify = patch.verify
          && !patch.verify.present
          && patch.verify.absent;
        // Fallback diff: when structured apply() returns no change, attempt the
        // stored unified diff captured against a known bundle version. This is
        // a stop-gap — drift is still real, but a good build shouldn't fail
        // when one patch's anchor moved if the textual diff still applies.
        let fallbackAppliedCode = null;
        if (noChange && !hasOnlyAbsentVerify
            && normalized.fallbackDiff && !patchOptions.disableFallback) {
          const fd = normalized.fallbackDiff;
          try {
            const fuzz = typeof fd.fuzz === 'number' ? fd.fuzz : 3;
            const result = applyPatch(preCode, fd.patch, { fuzzFactor: fuzz });
            if (typeof result === 'string') {
              fallbackAppliedCode = result;
              logger.log(`  [fallback] ${name}: stored-diff applied (fuzz=${fuzz}, capturedAgainst=${fd.capturedAgainst})`);
            } else {
              logger.warn(`  [fallback] ${name}: stored-diff did not apply (capturedAgainst=${fd.capturedAgainst})`);
            }
          } catch (err) {
            logger.warn(`  [fallback] ${name}: stored-diff threw: ${err.message}`);
          }
        }

        // If the fallback succeeded, treat the fallback result as the effective
        // applied code for the rest of this iteration (verify, capture, etc.).
        let effectiveCode = appliedCode;
        let usedFallback = false;
        if (noChange && !hasOnlyAbsentVerify && fallbackAppliedCode !== null
            && fallbackAppliedCode !== preCode) {
          effectiveCode = fallbackAppliedCode;
          usedFallback = true;
        }

        if (usedFallback) {
          results[name] = 'applied-fallback';
        } else if (noChange && !hasOnlyAbsentVerify) {
          logger.warn(`  [!] Patch "${name}" produced no changes. (check anchors)`);
          results[name] = 'no-change';
          fail('no-change (anchor likely drifted)');
          // Tag anchor-drift alert with patch name so patch-heal can route it.
          // Strategy: collect every stable string the patch told us to look for
          // (declared anchor.literal + verify.present strings + verify.absent
          // strings, in that priority), fuzzy-match each, dedupe, return top 3.
          try {
            const declaredLiteral = normalized.anchor?.literal ?? null;
            const presents = Array.isArray(normalized.verify?.present)
              ? normalized.verify.present
              : (normalized.verify?.present ? [normalized.verify.present] : []);
            const absents = Array.isArray(normalized.verify?.absent)
              ? normalized.verify.absent
              : (normalized.verify?.absent ? [normalized.verify.absent] : []);

            // Probes ordered by signal strength: declared literal > present > absent.
            const probes = [];
            if (declaredLiteral) probes.push({ source: 'anchor.literal', value: declaredLiteral });
            for (const p of presents) probes.push({ source: 'verify.present', value: p });
            for (const a of absents)  probes.push({ source: 'verify.absent',  value: a });

            const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const seenOffsets = new Set();
            const candidates = [];
            for (const { source, value } of probes) {
              if (typeof value !== 'string' || value.length < 4) continue;
              const hits = fuzzyMatch(preCode, new RegExp(escapeRe(value)));
              for (const h of hits) {
                // Dedupe within 50 bytes across probes.
                const bucket = Math.floor(h.offset / 50);
                if (seenOffsets.has(bucket)) continue;
                seenOffsets.add(bucket);
                candidates.push({
                  source,
                  probe: value.slice(0, 80),
                  offset: h.offset,
                  score: h.score,
                  snippet: h.snippet.slice(0, 120),
                });
                if (candidates.length >= 3) break;
              }
              if (candidates.length >= 3) break;
            }

            // verify_failed: which checks would have failed on the unchanged code.
            const verifyFailed = [];
            for (const p of presents) {
              if (!preCode.includes(p)) verifyFailed.push(`verify.present missing: ${p.slice(0, 80)}`);
            }
            for (const a of absents) {
              if (preCode.includes(a)) verifyFailed.push(`verify.absent still present: ${a.slice(0, 80)}`);
            }

            const alertLine = JSON.stringify({
              ts: new Date().toISOString(),
              type: 'anchor-drift',
              patch: name,
              version: patchOptions.version ?? null,
              anchor: {
                id: name,
                literal: declaredLiteral,
                verify_present: presents.map(s => s.slice(0, 80)),
                verify_absent:  absents.map(s => s.slice(0, 80)),
              },
              candidates,
              verify_failed: verifyFailed,
            });
            mkdirSync('storage/outputs', { recursive: true });
            appendFileSync(join('storage/outputs', 'anchor-drift.jsonl'), alertLine + '\n', 'utf8');

            if (candidates.length > 0) {
              for (const c of candidates) {
                logger.warn(`      Closest candidate (score ${c.score.toFixed(2)}, from ${c.source}): \`${c.snippet.slice(0, 80)}\` at offset ${c.offset}`);
              }
            } else if (probes.length === 0) {
              logger.warn(`      [drift] no anchor.literal or verify.present declared — cannot offer candidates. Add verify.present to "${name}" to enable drift hints.`);
            }
          } catch (_) { /* non-fatal */ }
        } else {
          results[name] = noChange ? 'no-change-ok' : 'applied';
        }
        // Capture a reverse diff from the effective post-apply code back to
        // `preCode` so the patched bundle can be restored byte-for-byte later.
        // Skip no-change applies — they contribute nothing to a revert.
        if (Array.isArray(patchOptions.captureReverse) && effectiveCode !== preCode && typeof effectiveCode === 'string') {
          const reverseDiff = createPatch(name, effectiveCode, preCode, 'patched', 'original');
          patchOptions.captureReverse.push({
            name,
            reverseDiff,
            preSha256: sha256(preCode),
            postSha256: sha256(effectiveCode),
          });
        }
        // Auto-inject __ccpCovHit() for patches that opted in via coverageMarker.
        // Best-effort: only attempt when the patch actually changed code, and
        // skip silently (with a notice) when no hook site is findable.
        if (normalized.coverageMarker && effectiveCode !== preCode) {
          const instrumented = injectCoverageHit(
            preCode, effectiveCode, normalized.coverageMarker, atSites,
          );
          if (instrumented === null) {
            logger.log?.(`  [coverage] ${name}: marker "${normalized.coverageMarker}" — no instrumentation site found, skipping`);
          } else {
            effectiveCode = instrumented;
          }
        }
        // Record per-patch trace for overlap detection. Compute diff spans from
        // a structuredPatch (pre → effective) so trace reflects what really
        // landed — including a fallback-diff application when apply() no-op'd.
        try {
          const phaseKey = phaseOf(patch);
          let diffSpans = [];
          if (typeof effectiveCode === 'string' && effectiveCode !== preCode) {
            const sp = structuredPatch(name, name, preCode, effectiveCode, 'pre', 'post', { context: 0 });
            diffSpans = diffSpansFromPatch(preCode, sp);
          }
          phaseTraces[phaseKey] = phaseTraces[phaseKey] || [];
          phaseTraces[phaseKey].push({
            name,
            phase: phaseKey,
            atSites: atSites ? atSites.slice() : null,
            diffSpans,
            allowOverlapWith: Array.isArray(normalized.allowOverlapWith) ? normalized.allowOverlapWith : [],
          });
        } catch (_) { /* trace is best-effort */ }
        // onAfterApply: patch may mutate ctx.appliedCode for last-mile fixups.
        lifecycleCtx.appliedCode = effectiveCode;
        {
          const hookRes = await fireHook(patch, 'onAfterApply', lifecycleCtx, logger);
          if (!hookRes.ok) {
            results[name] = 'error';
            fail(`onAfterApply threw: ${hookRes.error.message}`);
            continue;
          }
          if (typeof lifecycleCtx.appliedCode === 'string') {
            effectiveCode = lifecycleCtx.appliedCode;
          }
        }
        nextCode = effectiveCode;
        lifecycleCtx.appliedCode = effectiveCode;
      }

      if (patch.verify) {
        let issues = checkVerify(patch.verify, nextCode);
        if (issues.length > 0 && typeof patch.onVerifyFail === 'function') {
          lifecycleCtx.verify.issues = issues.slice();
          lifecycleCtx.attempt = 2;
          const hookRes = await fireHook(patch, 'onVerifyFail', lifecycleCtx, logger);
          if (!hookRes.ok) {
            fail(`onVerifyFail threw: ${hookRes.error.message}`);
          } else if (typeof hookRes.result === 'string') {
            // Retry verify against the hook-returned code (max 1 retry).
            const retryCode = hookRes.result;
            const retryIssues = checkVerify(patch.verify, retryCode);
            if (retryIssues.length === 0) {
              nextCode = retryCode;
              lifecycleCtx.appliedCode = retryCode;
              issues = [];
              logger.log(`  [hook] ${name}.onVerifyFail healed verify`);
            } else {
              issues = retryIssues;
            }
          }
        }
        for (const issue of issues) {
          logger.warn(`  [!] VERIFY FAILED: ${name} — ${issue}`);
          fail(`verify: ${issue}`);
        }
      }
    } catch (err) {
      logger.error(`  [!] Error applying patch "${name}": ${err.message}`);
      results[name] = 'error';
      fail(`apply() threw: ${err.message}`);
    }
  }

  // Overlap detection: scan each phase for pairs whose ranges intersect.
  // Conflicts are reported to the logger and a JSONL sidecar regardless of
  // strict mode; in strict mode they become fatal unless allowlisted.
  const allConflicts = [];
  for (const phaseKey of ['pre', 'main', 'post']) {
    const traces = phaseTraces[phaseKey] || [];
    if (traces.length < 2) continue;
    const conflicts = detectOverlapsInPhase(traces);
    for (const c of conflicts) {
      const aTrace = traces.find(t => t.name === c.a);
      const bTrace = traces.find(t => t.name === c.b);
      const allowed = (aTrace && aTrace.allowOverlapWith.includes(c.b))
                   || (bTrace && bTrace.allowOverlapWith.includes(c.a));
      const record = {
        ts: new Date().toISOString(),
        phase: c.phase,
        a: c.a,
        b: c.b,
        overlap: { kind: c.kind, rangeA: c.rangeA, rangeB: c.rangeB },
        allowed: !!allowed,
      };
      allConflicts.push(record);
      const msg = `overlap (${c.kind}) phase="${c.phase}" ${c.a} <-> ${c.b}` +
                  ` rangeA=[${c.rangeA[0]},${c.rangeA[1]}] rangeB=[${c.rangeB[0]},${c.rangeB[1]}]`;
      if (allowed) {
        logger.warn(`  [overlap] ${msg} (allowlisted)`);
      } else {
        logger.warn(`  [overlap] ${msg}`);
        if (globalStrict) {
          failures.push(
            `overlap: ${c.a} and ${c.b} touch overlapping ranges (${c.kind}) in phase="${c.phase}". ` +
            `Add allowOverlapWith: ['${c.b}'] to ${c.a} (or vice versa) to acknowledge.`
          );
        }
      }
    }
  }
  if (allConflicts.length > 0) {
    try {
      mkdirSync('storage/outputs', { recursive: true });
      const out = allConflicts.map(c => JSON.stringify(c)).join('\n') + '\n';
      appendFileSync(join('storage/outputs', 'patch-conflicts.jsonl'), out, 'utf8');
    } catch (_) { /* non-fatal */ }
  }

  if (failures.length > 0) {
    const mode = globalStrict ? 'strict mode' : 'required patches';
    throw new Error(
      `${failures.length} patch failure(s) in ${mode}:\n  - ${failures.join('\n  - ')}`
    );
  }

  // ── Apply-time coverage manifest ────────────────────────────────────────────
  // Always emitted (regardless of patchOptions.version), but written under a
  // versioned filename when version is known so multiple builds don't clobber
  // each other. Cross-referenced by `ccpatch coverage` against runtime hits.
  try {
    mkdirSync('storage/outputs', { recursive: true });
    const coverageManifest = {
      ccVersion: patchOptions.version ?? null,
      appliedAt: new Date().toISOString(),
      patches: {},
    };
    for (const name of Object.keys(results)) {
      const status = results[name];
      const patch = patches[name];
      const phase = phaseOf(patch);
      const applied = status === 'applied' || status === 'applied-fallback' || status === 'no-change-ok';
      const phaseTrace = (phaseTraces[phase] || []).find(t => t.name === name);
      const diffSpans = phaseTrace ? phaseTrace.diffSpans.length : 0;
      let reason = null;
      if (status === 'no-change') reason = 'no-change';
      else if (status === 'skipped') reason = 'skipped';
      else if (status === 'error') reason = 'error';
      const entry = { phase, applied, status, diffSpans };
      if (reason) entry.reason = reason;
      if (patch && patch.coverageMarker) entry.coverageMarker = patch.coverageMarker;
      coverageManifest.patches[name] = entry;
    }
    const tag = patchOptions.version ? `v${patchOptions.version}` : 'unknown';
    const covPath = join('storage/outputs', `coverage-apply-${tag}.json`);
    writeFileSync(covPath, JSON.stringify(coverageManifest, null, 2), 'utf8');
  } catch (err) {
    logger.warn?.(`  [!] Could not write coverage-apply manifest: ${err.message}`);
  }

  if (patchOptions.version) {
    try {
      mkdirSync('storage/outputs', { recursive: true });
      const outPath = join('storage/outputs', `patch-results-v${patchOptions.version}.json`);
      // Decorate results with the resolved variant per patch.
      const decorated = {};
      for (const name of Object.keys(results)) {
        const status = results[name];
        const variant = patches[name]?.__resolvedVariant ?? 'default';
        decorated[name] = { status, resolvedVariant: variant };
      }
      writeFileSync(outPath, JSON.stringify({
        version: patchOptions.version,
        timestamp: new Date().toISOString(),
        patches: decorated,
      }, null, 2), 'utf8');
      logger.log(`  [+] Patch results written to ${outPath}`);
    } catch (err) {
      logger.warn(`  [!] Could not write patch results catalog: ${err.message}`);
    }
  }

  return nextCode;
}

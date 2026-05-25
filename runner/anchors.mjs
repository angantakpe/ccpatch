/**
 * Central anchor registry — keyed by anchor ID, then by version string.
 *
 * Why this exists:
 *   Each patch used to hardcode its own regex pattern. When a new Claude Code
 *   version drifts an anchor, you'd have to hunt across 30+ files to find what
 *   broke. With a central registry, every version bump is a single-file update:
 *   add a versioned entry, leave the 'default' as fallback for unrecognised versions.
 *
 * Shape:
 *   anchors[id] = {
 *     literal?: string,
 *     default?: RegExp,
 *     anchors?: [{ priority: 'primary'|'fallback'|'last-resort', pattern: RegExp }, ...],
 *     '2.1.142'?: RegExp,
 *   }
 *
 * The optional `literal` field is the stable string token used by
 * findFunctionByLiteral (runner/ast-anchor.mjs) AND by the refmap generator
 * (tools/build-refmap.mjs). Only anchors that carry a `literal` are eligible
 * for refmap-driven resolution. Anchors that intentionally rely on
 * structural regex shape (no stable literal) should omit it.
 *
 * The optional `anchors[]` array declares an ordered fallback chain. When
 * resolveAnchor() is called with the bundle `code`, it probes each tier in
 * order and returns the first whose pattern matches — the same idea
 * expose_tool_dispatch implements by hand (primary → fallback → last-resort).
 *
 * Resolution precedence inside resolveAnchor():
 *   1. Explicit version-specific regex entry (anchors[id][version])
 *   2. Refmap entry for that bundle version (refmaps/<version>.json), if any
 *   3. anchors[id].anchors[] tier list — first matching tier (probes `code` when supplied)
 *   4. anchors[id].default regex
 *
 * Usage from a patch:
 *   import { resolveAnchor } from '../runner/anchors.mjs';
 *   const pattern = resolveAnchor('isDurableCronEnabled', opts?.version);
 *
 * ─── Adoption policy ─────────────────────────────────────────────────────────
 *   - NEW patches with version-sensitive anchors MUST register them here.
 *   - Existing patches with inline regex are grandfathered: migrate opportunistically
 *     when the anchor drifts (you'll be editing the patch anyway).
 *   - Anchors that are not expected to drift across versions (stable strings like
 *     "tengu_kairos_*" flag keys, fixed module wrappers) do NOT need a registry
 *     entry — inline regex is fine.
 *
 *   The registry's value is in giving version-specific overrides a single home.
 *   It is NOT a goal to centralise every regex in the codebase.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { loadRefmap, resolveSymbol } from './refmap.mjs';

export const anchors = {
  isDurableCronEnabled: {
    literal: 'tengu_kairos_cron_durable',   // stable string literal for findFunctionByLiteral()
    // Function name rotates per version; "tengu_kairos_cron_durable" string is stable.
    default: /function (\w+)\(\)\{return \w+\("tengu_kairos_cron_durable",!0,\w+\)\}/,
  },

  isLoopDynamicEnabled: {
    literal: 'tengu_kairos_loop_dynamic',    // stable string literal for findFunctionByLiteral()
    // "tengu_kairos_loop_dynamic" string is stable; fn name and helper rotate.
    default: /function ([A-Za-z_$][\w$]*)\(\)\{return [A-Za-z_$][\w$]*\("tengu_kairos_loop_dynamic",!1\)\}/,
  },

  isLoopPromptEnabled: {
    literal: 'tengu_kairos_loop_prompt',     // stable string literal for findFunctionByLiteral()
    default: /function ([A-Za-z_$][\w$]*)\(\)\{return [A-Za-z_$][\w$]*\("tengu_kairos_loop_prompt",!1\)\}/,
  },

  isPlanModeInterviewEnabled: {
    literal: 'tengu_plan_mode_interview_phase',  // stable string literal for findFunctionByLiteral()
    // Env var + feature flag string + helper invocations are stable; fn names rotate.
    default: /function ([A-Za-z_$][\w$]*)\(\)\{let H=process\.env\.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE;if\([A-Za-z_$][\w$]*\(H\)\)return!0;if\([A-Za-z_$][\w$]*\(H\)\)return!1;return [A-Za-z_$][\w$]*\("tengu_plan_mode_interview_phase",!1\)\}/,
  },
};

/**
 * Resolve the best anchor pattern for a given version.
 * Returns the version-specific entry if present, otherwise the first registered
 * tier (or `default`). Returns null if the anchor ID is unknown.
 *
 * For multi-tier anchors (entries with an ordered `anchors: []` list), this
 * function returns the *first* tier without probing. To probe the bundle and
 * get the first tier whose pattern actually matches, pass `code` as the third
 * argument or use {@link resolveAnchorMatching}.
 *
 * @param {string} id      - Anchor name (key in `anchors`)
 * @param {string} [version] - Bundle version string e.g. "2.1.142"
 * @param {string} [code]    - Optional bundle source. When provided and the
 *                             entry has `anchors[]`, returns the first tier
 *                             whose pattern matches `code`.
 * @returns {{ pattern: RegExp, source: string, priority?: string }|null}
 */
export function resolveAnchor(id, version, code) {
  const entry = anchors[id];
  if (!entry) return null;
  // 1. Explicit version-specific regex entry wins.
  if (version && Object.prototype.hasOwnProperty.call(entry, version)) {
    return { pattern: entry[version], source: 'registry-version' };
  }
  // 2. Refmap-driven fallback: synthesise `function <fn>` regex from the
  //    refmap-resolved symbol for this version.
  if (version) {
    try {
      const refmap = loadRefmap(version);
      const sym = resolveSymbol(refmap, id);
      if (sym && sym.fn) {
        const escaped = sym.fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { pattern: new RegExp(`function\\s+${escaped}\\b`), source: 'refmap' };
      }
    } catch { /* refmap is optional augmentation — never fatal */ }
  }
  // 3. Multi-tier `anchors: []` list (new shape). Try tiers in order; return
  //    the first whose pattern matches `code` if probing, otherwise the first.
  if (Array.isArray(entry.anchors) && entry.anchors.length > 0) {
    if (typeof code === 'string') {
      for (const tier of entry.anchors) {
        if (!tier?.pattern) continue;
        if (tier.pattern.test(code)) {
          // Reset lastIndex for /g regexes so subsequent uses start fresh.
          if (tier.pattern.global) tier.pattern.lastIndex = 0;
          return { pattern: tier.pattern, source: 'registry-tier', priority: tier.priority ?? 'primary' };
        }
        if (tier.pattern.global) tier.pattern.lastIndex = 0;
      }
      // None matched — fall through to default.
    } else {
      const first = entry.anchors[0];
      return { pattern: first.pattern, source: 'registry-tier', priority: first.priority ?? 'primary' };
    }
  }
  // 4. Default regex fallback.
  const regex = entry.default ?? null;
  return regex ? { pattern: regex, source: 'registry-default' } : null;
}

/**
 * Convenience wrapper: probe the bundle and return the first matching tier.
 * Equivalent to `resolveAnchor(id, version, code)` but always probes; useful
 * for diagnostic tools that want to know *which* tier matched.
 *
 * @param {string} id
 * @param {string} version
 * @param {string} code
 * @returns {{ pattern: RegExp, source: string, priority?: string }|null}
 */
export function resolveAnchorMatching(id, version, code) {
  return resolveAnchor(id, version, code);
}

/**
 * Return the stable string literal for an anchor ID, for use with
 * findFunctionByLiteral() in runner/ast-anchor.mjs.
 * Returns null if the anchor has no registered literal.
 *
 * @param {string} id
 * @returns {string|null}
 */
export function resolveAnchorLiteral(id) {
  return anchors[id]?.literal ?? null;
}

/**
 * Read-only anchor probe used by `ccpatch doctor`.
 * Runs the patch's apply() on a copy of `code` (never persisted), then classifies
 * the result using the patch's own verify rules + fuzzyMatch for drift hints.
 *
 * Returns: { status: 'ok'|'drift'|'missing', detail?: string }
 */
export function probeAnchor(patch, code) {
  if (!patch || typeof patch.apply !== 'function') {
    return { status: 'missing', detail: 'patch has no apply()' };
  }

  let out;
  try {
    out = patch.apply(code);
  } catch (err) {
    return classifyDrift(patch, code, `apply() threw: ${err.message}`);
  }
  if (typeof out !== 'string') {
    return { status: 'missing', detail: `apply() returned ${typeof out}` };
  }

  const changed = out !== code;
  const v = patch.verify ?? null;
  const presents = v ? toList(v.present) : [];
  const absents  = v ? toList(v.absent)  : [];

  const issues = v ? checkVerifyLocal(v, out) : [];
  if (issues.length > 0) return classifyDrift(patch, code, issues[0]);

  if (!changed && presents.length === 0 && absents.length > 0) {
    return { status: 'ok', weak: isWeakLocal(v) };
  }
  if (!changed && presents.length === 0 && absents.length === 0) {
    return classifyDrift(patch, code, 'no change and no verify to confirm anchor');
  }
  return { status: 'ok', weak: isWeakLocal(v) };
}

function checkVerifyLocal(verify, code) {
  const issues = [];
  const presents = toList(verify.present);
  const absents  = toList(verify.absent);
  for (const s of presents) if (!code.includes(s)) issues.push(`verify.present missing: ${s.slice(0, 60)}`);
  for (const s of absents)  if (code.includes(s))  issues.push(`verify.absent still present: ${s.slice(0, 60)}`);
  if (verify.count !== undefined && verify.count !== null) {
    const c = typeof verify.count === 'number' ? { present: verify.count } : verify.count;
    const count = (needle) => {
      let n = 0, idx = 0;
      while ((idx = code.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
      return n;
    };
    if (typeof c.present === 'number') {
      const total = presents.reduce((n, s) => n + count(s), 0);
      if (total !== c.present) issues.push(`expected count.present=${c.present}, actual=${total}`);
    }
    if (typeof c.absent === 'number') {
      const total = absents.reduce((n, s) => n + count(s), 0);
      if (total !== c.absent) issues.push(`expected count.absent=${c.absent}, actual=${total}`);
    }
  }
  return issues;
}

function isWeakLocal(verify) {
  if (!verify) return true;
  const hasP = toList(verify.present).length > 0;
  const hasA = toList(verify.absent).length > 0;
  const hasC = verify.count !== undefined && verify.count !== null;
  return hasP && !hasA && !hasC;
}

function toList(x) {
  return Array.isArray(x) ? x : (x ? [x] : []);
}

function classifyDrift(patch, code, detail) {
  // Try fuzzyMatch against the registered anchor literal (if any) to distinguish
  // drift-with-candidate from genuinely-missing.
  const lit = patch?.anchor?.literal;
  if (lit) {
    const escaped = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cands = fuzzyMatch(code, new RegExp(escaped));
    if (cands.length > 0) {
      const top = cands[0];
      return { status: 'drift', detail: `${detail}; candidate score=${top.score.toFixed(2)} @ offset ${top.offset}` };
    }
  }
  return { status: 'missing', detail };
}

/**
 * When a regex anchor fails to match, find near-miss candidates in the bundle.
 *
 * Strategy:
 *   1. Extract quoted string literals (≥8 chars) from pattern.source — these are the
 *      stable identifiers (e.g. "tengu_kairos_cron_durable").
 *   2. If none found, fall back to long word tokens (\b\w{6,}\b) from pattern.source.
 *   3. For each literal, scan `code` with indexOf (NOT regex — bundle is 16MB).
 *   4. For each hit: extract a 200-char window, score by token overlap with pattern.source.
 *   5. Return top 3 candidates sorted by score desc, deduped within 50 bytes of each other.
 *
 * @param {string} code    - The full bundle source
 * @param {RegExp} pattern - The anchor regex that failed to match
 * @returns {{ offset: number, snippet: string, score: number }[]}
 */
export function fuzzyMatch(code, pattern) {
  const src = pattern.source;

  // Step 1: extract stable quoted literals from the regex source
  const literalRe = /["']([^"']{8,})["']/g;
  const literals = [];
  let m;
  while ((m = literalRe.exec(src)) !== null) literals.push(m[1]);

  // Step 2: fallback to long word tokens
  const searchTerms = literals.length > 0
    ? literals
    : (src.match(/\b\w{6,}\b/g) ?? []);

  if (searchTerms.length === 0) return [];

  // Step 3: score tokens from pattern.source for overlap scoring
  const patternTokens = src.match(/\b\w+\b/g) ?? [];

  const raw = [];
  for (const term of searchTerms) {
    let pos = 0;
    while (true) {
      const idx = code.indexOf(term, pos);
      if (idx === -1) break;
      const start = Math.max(0, idx - 100);
      const end = Math.min(code.length, idx + 100);
      const snippet = code.slice(start, end);
      // Step 4: score by token overlap
      const hits = patternTokens.filter(t => snippet.includes(t)).length;
      const score = patternTokens.length > 0 ? hits / patternTokens.length : 0;
      raw.push({ offset: idx, snippet, score });
      pos = idx + 1;
      if (raw.length > 500) break; // safety cap for very common literals
    }
  }

  // Step 5: sort by score, deduplicate within 50 bytes, return top 3
  raw.sort((a, b) => b.score - a.score);
  const result = [];
  for (const c of raw) {
    if (result.every(r => Math.abs(r.offset - c.offset) > 50)) {
      result.push(c);
      if (result.length === 3) break;
    }
  }
  return result;
}

// `--profile=native` post-filter.
//
// The native profile produces a bundle that can be repacked into a Bun
// single-executable (SEA). Two patches are mechanically incompatible with
// that path:
//   - esm_compat   — rewrites the CJS IIFE wrapper to ESM, which Bun's SEA
//                    packer cannot re-bundle.
//   - bun_shim — injects a Bun polyfill that conflicts with the runtime
//                    Bun already provides in the SEA host.
//
// Rather than make every consumer remember to exclude these, we drop them
// here whenever profile === 'native'. The build path logs a single
// "[native] auto-excluded …" line so users see what happened.

export const NATIVE_INCOMPATIBLE_PATCHES = Object.freeze(['esm_compat', 'bun_shim']);

/**
 * Given the resolved list of patches to apply and the active profile name,
 * return a possibly-filtered list plus the names of any patches that were
 * dropped. When profile is anything other than "native", returns the input
 * unchanged.
 */
export function applyNativeProfileFilter(patchesToApply, profile) {
  if (profile !== 'native') {
    return { patches: patchesToApply, excluded: [] };
  }
  const drop = new Set(NATIVE_INCOMPATIBLE_PATCHES);
  const excluded = [];
  const kept = [];
  for (const name of patchesToApply) {
    if (drop.has(name)) excluded.push(name);
    else kept.push(name);
  }
  return { patches: kept, excluded };
}

// ── WS6 Item 8: surface native grow-path platform degradation at runtime ─────
//
// The native repacker (bin/repack-bundle.mjs) can only GROW the embedded JS
// region — i.e. accept a patched bundle larger than the original — on ELF
// (linux-x64) binaries. On every other host (darwin-arm64, darwin-x64,
// win32-x64, linux-arm64, …) the only available path is a length-preserving
// in-place splice; if the patched JS exceeds the original region the repacker
// must either drop patches to fit or fail. Today that limitation is documented
// only in the README, so on a Mac the reduced patch set / dropped patches were
// effectively silent. These helpers let `doctor` and the build/apply path report
// EXACTLY which platform is affected and (when WS1's repacker tells us) which
// patches were dropped and why.

/**
 * Whether the native grow-repack path is available for the given host platform.
 * Grow-repack is implemented for ELF (linux-x64) only — keep this in lockstep
 * with the `isElf`/grow guard in bin/repack-bundle.mjs. `platform`/`arch`
 * default to the current host (process.platform / process.arch).
 */
export function nativeGrowPathAvailable(platform = process.platform, arch = process.arch) {
  return platform === 'linux' && arch === 'x64';
}

/**
 * Canonical "<platform>-<arch>" host string used in degradation messages
 * (e.g. "darwin-arm64"). Mirrors the platform strings WS1 emits in its
 * [repack:skip] line so doctor and the repacker speak the same dialect.
 */
export function hostPlatformLabel(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * Tolerant parser for WS1's structured repack-skip line. WS1 emits a single
 * stdout line shaped like:
 *
 *   [repack:skip] {"reason":"native-grow-path-unavailable","platform":"darwin-arm64","droppedPatches":["a","b"]}
 *
 * WS1 finalizes the exact shape, so this parser is deliberately forgiving
 * (documented ASSUMED shape above):
 *   - scans ALL lines of `text`; uses the LAST `[repack:skip]` line if several.
 *   - finds the first `{` after the marker and JSON.parses from there, so a
 *     differing prefix/spacing doesn't matter.
 *   - tolerates field drift: `droppedPatches` may also arrive as `dropped`,
 *     `patches`, or `droppedPatchNames`; `platform` may also be `target` /
 *     `host`; `reason` defaults to 'native-grow-path-unavailable'.
 *   - if JSON is absent/garbage but the marker is present, still returns a
 *     best-effort object so the caller can degrade to a generic message.
 *
 * Returns null when no `[repack:skip]` marker is present at all. Otherwise
 * returns { reason, platform, droppedPatches: string[], raw }.
 */
export function parseRepackSkip(text) {
  if (text == null) return null;
  const str = String(text);
  const MARK = '[repack:skip]';
  // Find the LAST occurrence so a later skip line wins over an earlier one.
  const markIdx = str.lastIndexOf(MARK);
  if (markIdx === -1) return null;

  const afterMark = str.slice(markIdx + MARK.length);
  // Restrict to this line so we don't swallow JSON from a following log line.
  const line = afterMark.split('\n')[0];

  let obj = null;
  const braceIdx = line.indexOf('{');
  if (braceIdx !== -1) {
    // Walk to the matching closing brace (balanced, string-aware) so trailing
    // text after the JSON object doesn't break the parse.
    const jsonText = extractBalancedObject(line.slice(braceIdx));
    if (jsonText) {
      try { obj = JSON.parse(jsonText); } catch (_) { obj = null; }
    }
  }

  const o = obj && typeof obj === 'object' ? obj : {};
  const dropped =
    o.droppedPatches ?? o.dropped ?? o.droppedPatchNames ?? o.patches ?? [];
  const droppedPatches = Array.isArray(dropped)
    ? dropped.map(String)
    : (dropped ? [String(dropped)] : []);
  const platform = o.platform ?? o.target ?? o.host ?? null;
  const reason = o.reason ?? 'native-grow-path-unavailable';
  return { reason, platform, droppedPatches, raw: obj };
}

/**
 * Extract a balanced `{...}` object from the START of `s` (s[0] must be `{`).
 * String-aware so braces inside quoted values don't confuse the matcher.
 * Returns the substring including both braces, or null if unbalanced.
 */
function extractBalancedObject(s) {
  if (s[0] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * Render the human-facing platform-degradation message shared by doctor and the
 * build/apply path. Produces, e.g.:
 *
 *   3 patches skipped: native grow-path unavailable on darwin-arm64
 *   (mach-o grow not supported for this subtype) — esm_compat, bun_shim, debug
 *
 * `droppedPatches` may be empty (count unknown) — then we emit a count-less
 * variant. `platform` falls back to the host label when WS1 didn't supply one.
 */
export function formatPlatformDegradation({ platform, droppedPatches = [], reason } = {}) {
  const plat = platform || hostPlatformLabel();
  const detail = reasonDetail(reason, plat);
  const names = Array.isArray(droppedPatches) ? droppedPatches.filter(Boolean) : [];
  if (names.length > 0) {
    return `${names.length} patch(es) skipped: native grow-path unavailable on ${plat} ` +
      `(${detail}) — ${names.join(', ')}`;
  }
  return `Patches may be skipped: native grow-path unavailable on ${plat} (${detail})`;
}

/**
 * Map a machine reason code (or platform) to a short human explanation of why
 * the grow path is unavailable. Tolerant of unknown reason codes.
 */
function reasonDetail(reason, platform) {
  if (reason && reason !== 'native-grow-path-unavailable') {
    return String(reason);
  }
  if (platform && platform.startsWith('darwin')) {
    return 'Mach-O grow-repack not supported for this subtype';
  }
  if (platform && platform.startsWith('win32')) {
    return 'PE grow-repack not supported';
  }
  return 'grow-repack is implemented for ELF (linux-x64) only';
}

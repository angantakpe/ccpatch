// runner/cli/style.mjs — tiny ANSI styling + display-width helpers shared by the
// build-time banners and logs.
//
// Color is opt-out and CI-safe: it honors NO_COLOR (https://no-color.org) and
// FORCE_COLOR, and otherwise switches itself off whenever stdout is not a TTY,
// so piped / redirected / CI logs stay plain. The emoji icons below are emitted
// regardless of color (they're just text); only the SGR escapes are gated.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip SGR color escapes from a string (module-local helper for vwidth). */
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

// Glyphs that occupy two terminal columns despite a small JS .length. We keep
// this set deliberately tight — only the wide emoji ccpatch actually renders
// inside width-sensitive boxes (the sparkle in a banner title) plus the astral
// emoji block. Bare U+26A0 (⚠ without VS16) is intentionally treated as width 1
// to match terminals' text-presentation default, so box warning rows stay crisp.
const WIDE_BMP = new Set([0x2728, 0x2705, 0x274C, 0x2B50]);

function isWide(cp) {
  if (cp >= 0x1f000) return true;          // astral emoji / pictographs (🩺 ✨ 📦 🚀 …)
  if (cp >= 0x1100 && cp <= 0x115f) return true; // Hangul Jamo (defensive)
  return WIDE_BMP.has(cp);
}

/**
 * Visible column width of a string: ANSI-stripped, wide/emoji glyphs counted as
 * two columns, and the VS16 emoji-presentation selector / zero-width joiner
 * counted as zero. Used for every box-padding calculation so color codes and
 * emoji never skew alignment.
 */
export function vwidth(s) {
  const str = stripAnsi(s);
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue; // VS16 / ZWJ → zero width
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function colorEnabled() {
  if (process.env.NO_COLOR != null) return false;
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0') return true;
  return !!(process.stdout && process.stdout.isTTY);
}

// True when SGR color escapes should be emitted (NO_COLOR / FORCE_COLOR / TTY).
const COLOR = colorEnabled();

// ── Verbosity (two-tier) ─────────────────────────────────────────────────────
// Patches and shims emit incidental "[name] did X" sub-chatter directly via
// console.log (they run inside apply(), outside the CLI's leveled logger). At
// the default verbosity that chatter is pure noise — the runner already prints a
// ✨ line per patch and a summary box — so it is suppressed and surfaces only at
// DEBUG level. The two tiers:
//   compact (default) — phase headers, the per-patch ✨ line, warnings, and the
//                       summary. Sub-chatter hidden. This is the `info` log
//                       level, the default for an interactive build.
//   verbose           — everything, including every [unhide_features]/[builtin]/
//                       [shim] line. Turned on by --verbose / --log-level=debug
//                       / CCPATCH_LOG_LEVEL=debug / CCPATCH_VERBOSE=1.
//
// The decision is carried through CCPATCH_LOG_LEVEL (set by the CLI's
// extractGlobalFlags) and CCPATCH_VERBOSE, so the doctor pre-pass and any
// child process spawned by the build share one verbosity decision rather than
// each re-deriving it from their own stdout.TTY.
function resolveVerbose() {
  if (process.env.CCPATCH_VERBOSE != null) return process.env.CCPATCH_VERBOSE !== '0';
  const lvl = process.env.CCPATCH_LOG_LEVEL;
  if (lvl === 'debug') return true;
  if (lvl === 'silent' || lvl === 'error' || lvl === 'warn' || lvl === 'info') return false;
  // No explicit signal: compact. Routine builds stay quiet; pipe to a file with
  // --verbose (or --log-level=debug) when the full transform trace is wanted.
  return false;
}

let VERBOSE = resolveVerbose();

/** True when full per-patch sub-chatter should be emitted. */
export function isVerbose() { return VERBOSE; }

/**
 * Force the verbosity tier for the rest of the process and export the decision
 * to child processes via CCPATCH_VERBOSE. Called by the build CLI once it has
 * parsed --verbose / --log-level so the doctor pre-pass and patch sub-chatter
 * agree on one answer.
 */
export function setVerbose(on) {
  VERBOSE = !!on;
  process.env.CCPATCH_VERBOSE = on ? '1' : '0';
}

/**
 * Per-patch / per-shim sub-chatter sink. Callers use this instead of
 * console.log for the incidental "[name] did X" lines that help when debugging
 * a drifted anchor but are noise in a routine build. Suppressed in compact
 * mode; passed through verbatim in verbose mode. The callers' leading two-space
 * indent is preserved.
 */
export function ccpLog(...args) {
  if (VERBOSE) console.log(...args);
}

const wrap = (open, close) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s == null ? '' : s));

/** Minimal SGR palette. Each helper is a no-op passthrough when color is off. */
export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Friendly glyph set used across banners and logs. */
export const icon = {
  ok: '✅',
  drift: '⚠️',
  missing: '❌',
  deprecated: '⊘',
  apply: '✨',
  doctor: '🩺',
  build: '✅',
  fail: '❌',
  box: '📦',
  rocket: '🚀',
  warn: '⚠️',
  arrow: '→',
};

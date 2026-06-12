/**
 * runner/cli/banner.mjs — build-time rounded-box banner.
 *
 * Renders a responsive rounded box (mirrors the runtime boot banner installed
 * by core/boot_banner) for the build CLI. Width adapts to the terminal, capped
 * at 100 cols and floored at 24; long values are clipped with an ellipsis.
 *
 * This is the build-time twin of runner/shims/boot-banner-v1.js.txt — kept as a
 * separate implementation because that one is injected into the patched bundle
 * as a verbatim string, while this one runs in the patcher's own Node process.
 */

import { style, vwidth } from './style.mjs';

/**
 * Canonical ccpatch safety-caveat lines, shared by every banner that surfaces
 * the warnings (e.g. scripts/print-banner.mjs). Kept here, next to the shared
 * renderer, so the wording stays in one place.
 *
 * The capability gate is enforced at BUILD time (it decides which patches enter
 * the bundle); it does not constrain anything at runtime. In particular,
 * UPSTREAM Claude Code's own --dangerously-skip-permissions flag (not a ccpatch
 * flag) removes runtime tool prompts, so patched tool-dispatch code then runs
 * unprompted. The middle line below attributes the flag to upstream explicitly
 * — in a security-sensitive tool, ambiguity about WHO enforces WHAT is itself
 * a defect — sized to stay within the responsive box width.
 *
 * @type {string[]}
 */
export const SAFETY_WARNINGS = [
  '⚠ Unofficial — may break when Claude Code updates.',
  '⚠ Cap gate is build-time; upstream\'s --dangerously-skip-permissions skips runtime prompts.',
  '⚠ Review THREAT_MODEL.md before enabling network/env patches.',
];

function termCols() {
  const c = (process.stdout && process.stdout.columns) ||
            (process.stderr && process.stderr.columns) || 80;
  return c > 0 ? c : 80;
}

function rep(ch, n) { return n > 0 ? ch.repeat(n) : ''; }

function clip(s, n) {
  s = String(s == null ? '' : s);
  if (n <= 0) return '';
  if (s.length <= n) return s;
  if (n === 1) return '…';
  return s.slice(0, n - 1) + '…';
}

/**
 * Render a compact single-line build status header for the build CLI.
 *
 * This is intentionally NOT a full box — scripts/print-banner.mjs already
 * renders the project-level boxed overview at the make level.  Repeating a
 * second box of the same shape would look copy-pasted.  Instead this emits a
 * single styled line that reads as "build starting" metadata, visually distinct
 * from the outer banner.
 *
 * Example (color):
 *   ✨ ccpatch v2.1.167  ·  standard  ·  28 patches  →  cli.v2.1.167.patched.mjs
 *
 * @param {{ version?: string|null, profile?: string, patchCount?: number, outputName?: string }} opts
 * @returns {string}
 */
export function renderBuildStatusHeader({ version = null, profile = 'default', patchCount = 0, outputName = '' } = {}) {
  const dot = style.dim('  ·  ');
  const arrow = style.dim('  →  ');
  let line = style.bold(version ? `✨ ccpatch v${version}` : '✨ ccpatch');
  line += dot + style.dim(profile || 'default');
  line += dot + style.dim(`${patchCount} patch${patchCount === 1 ? '' : 'es'}`);
  if (outputName) line += arrow + style.cyan(outputName);
  return line;
}

/**
 * Render a rounded box with a title embedded in the top border and a list of
 * rows. Returns the multi-line string (no trailing newline).
 *
 * Each row may be:
 *   - [label, value]  → aligned two-column line (`  label   value`)
 *   - string          → plain left-indented line (use '' for a blank spacer)
 *   - null            → a horizontal section divider (├──┤)
 *
 * An optional `icon` is rendered just before the title inside the top border.
 *
 * Border glyphs are tinted cyan and the title is bold; labels are dimmed. All
 * padding math runs on the visible (ANSI-stripped, emoji-aware) width via
 * vwidth(), so color codes and wide glyphs never skew the box edges. When color
 * is disabled (NO_COLOR / non-TTY) every style helper is an identity passthrough
 * and the box renders exactly as before.
 *
 * @param {{ title: string, rows?: Array<[string,string]|string|null>, cols?: number, labelMax?: number, icon?: string }} opts
 * @returns {string}
 */
export function renderBanner({ title, rows = [], cols, labelMax = 16, icon = '' } = {}) {
  let width = Math.min(cols || termCols(), 100);
  if (width < 24) width = 24;
  const inner = width - 2;

  let labelW = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const l = String(row[0] == null ? '' : row[0]).length;
    if (l > labelW) labelW = l;
  }
  if (labelW > labelMax) labelW = labelMax;

  const B = style.cyan; // border tint
  // `content` may carry color codes; pad against its visible width.
  const pad = (content) => B('│') + content + rep(' ', Math.max(0, inner - vwidth(content))) + B('│');
  const out = [];

  const head = (icon ? icon + ' ' : '') + String(title == null ? '' : title);
  let titleSeg = ' ' + head + ' ';
  if (vwidth(titleSeg) > inner - 1) titleSeg = clip(titleSeg, inner - 1);
  const fill = Math.max(0, inner - 1 - vwidth(titleSeg));
  out.push(B('╭─') + style.bold(titleSeg) + B(rep('─', fill) + '╮'));

  for (const row of rows) {
    if (row === null) {
      out.push(B('├' + rep('─', inner) + '┤'));
    } else if (Array.isArray(row)) {
      const lab = clip(row[0], labelW);
      const left = '  ' + style.dim(lab) + rep(' ', labelW - vwidth(lab)) + '  ';
      const leftW = labelW + 4; // 2 leading + labelW + 2 trailing spaces
      out.push(pad(left + clip(row[1], inner - leftW)));
    } else {
      out.push(pad('  ' + clip(row, inner - 2)));
    }
  }

  out.push(B('╰' + rep('─', inner) + '╯'));

  return out.join('\n');
}

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
 * Render a rounded box with a title embedded in the top border and a list of
 * rows. Returns the multi-line string (no trailing newline).
 *
 * Each row may be:
 *   - [label, value]  → aligned two-column line (`  label   value`)
 *   - string          → plain left-indented line (use '' for a blank spacer)
 *   - null            → a horizontal section divider (├──┤)
 *
 * @param {{ title: string, rows?: Array<[string,string]|string|null>, cols?: number, labelMax?: number }} opts
 * @returns {string}
 */
export function renderBanner({ title, rows = [], cols, labelMax = 16 } = {}) {
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

  const pad = (content) => '│' + content + rep(' ', inner - content.length) + '│';
  const out = [];

  let titleSeg = ' ' + String(title == null ? '' : title) + ' ';
  if (titleSeg.length > inner - 1) titleSeg = clip(titleSeg, inner - 1);
  const fill = inner - 1 - titleSeg.length;
  out.push('╭─' + titleSeg + rep('─', fill) + '╮');

  for (const row of rows) {
    if (row === null) {
      out.push('├' + rep('─', inner) + '┤');
    } else if (Array.isArray(row)) {
      const lab = clip(row[0], labelW);
      const left = '  ' + lab + rep(' ', labelW - lab.length) + '  ';
      out.push(pad(left + clip(row[1], inner - left.length)));
    } else {
      out.push(pad('  ' + clip(row, inner - 2)));
    }
  }

  out.push('╰' + rep('─', inner) + '╯');

  return out.join('\n');
}

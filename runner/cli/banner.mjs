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
 * [label, value] rows. Returns the multi-line string (no trailing newline).
 *
 * @param {{ title: string, rows?: Array<[string, string]>, cols?: number }} opts
 * @returns {string}
 */
export function renderBanner({ title, rows = [], cols } = {}) {
  let width = Math.min(cols || termCols(), 100);
  if (width < 24) width = 24;
  const inner = width - 2;

  let labelW = 0;
  for (const [label] of rows) {
    const l = String(label == null ? '' : label).length;
    if (l > labelW) labelW = l;
  }
  if (labelW > 16) labelW = 16;

  const out = [];

  let titleSeg = ' ' + String(title == null ? '' : title) + ' ';
  if (titleSeg.length > inner - 1) titleSeg = clip(titleSeg, inner - 1);
  const fill = inner - 1 - titleSeg.length;
  out.push('╭─' + titleSeg + rep('─', fill) + '╮');

  for (const [label, value] of rows) {
    const lab = clip(label, labelW);
    const left = '  ' + lab + rep(' ', labelW - lab.length) + '  ';
    const avail = inner - left.length;
    let content = left + clip(value, avail);
    content += rep(' ', inner - content.length);
    out.push('│' + content + '│');
  }

  out.push('╰' + rep('─', inner) + '╯');

  return out.join('\n');
}

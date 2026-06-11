// `ccpatch dissect <cli.js>` — read-only structural analysis of an UNPATCHED
// bundle. Answers "what is in this bundle?" the way `doctor` answers "will my
// anchors land?". Composes the shared analyzeBundle() primitive (runner/
// dissect.mjs) — the same model `refmap` projects from, so the two cannot drift.
//
// Modes (all read-only, no writes):
//   ccpatch dissect <cli.js>                    structural anchor table
//   ccpatch dissect <cli.js> --context 80       + source window per anchor
//   ccpatch dissect <cli.js> --ownership        anchor → owning patch → shim
//   ccpatch dissect <new> --against <old>       cross-version anchor diff
//   ccpatch dissect <claude-binary> --native    decode the Bun SEA module graph
//   ... --json on any of the above for machine output.

import fs from 'node:fs';

import { style } from './style.mjs';
import {
  analyzeBundle,
  diffAnalyses,
  buildOwnershipMap,
} from '../dissect.mjs';

function pad(s, w) { return String(s).padEnd(w); }

/**
 * ctx = { options, patches, logger }. options carries:
 *   inputPath, againstPath, native, ownership, context, ccVersion, json.
 */
export async function runDissect(ctx) {
  const { options, logger } = ctx;

  if (!fs.existsSync(options.inputPath)) {
    logger.error(`Error: bundle not found at ${options.inputPath}`);
    return 1;
  }

  let analysis;
  try {
    analysis = analyzeBundle(options.inputPath, {
      ccVersion: options.ccVersion ?? null,
      context: options.context || 0,
      native: !!options.native,
    });
  } catch (err) {
    logger.error(`Error: failed to analyze ${options.inputPath}: ${err.message}`);
    return 1;
  }

  // ── Cross-version diff ──────────────────────────────────────────────────
  if (options.againstPath) {
    if (!fs.existsSync(options.againstPath)) {
      logger.error(`Error: --against bundle not found at ${options.againstPath}`);
      return 1;
    }
    let prior;
    try {
      prior = analyzeBundle(options.againstPath, { native: !!options.native });
    } catch (err) {
      logger.error(`Error: failed to analyze --against ${options.againstPath}: ${err.message}`);
      return 1;
    }
    const diff = diffAnalyses(prior, analysis);
    if (options.json) {
      logger.log(JSON.stringify({
        from: { sha256: prior.bundleSha256, format: prior.format },
        to: { sha256: analysis.bundleSha256, format: analysis.format },
        summary: diff.summary,
        rows: diff.rows,
      }, null, 2));
      return 0;
    }
    renderDiff(diff, prior, analysis, logger);
    // Non-zero when anchors moved/renamed/vanished — useful as a CI gate.
    const drifted = diff.summary.moved + diff.summary.renamed + diff.summary.vanished;
    return drifted > 0 ? 3 : 0;
  }

  // ── Ownership map ───────────────────────────────────────────────────────
  if (options.ownership) {
    const map = buildOwnershipMap(analysis);
    if (options.json) {
      logger.log(JSON.stringify({ bundle: bundleHeader(analysis), ownership: map }, null, 2));
      return 0;
    }
    renderOwnership(analysis, map, logger);
    return 0;
  }

  // ── Default structural report ───────────────────────────────────────────
  if (options.json) {
    logger.log(JSON.stringify(analysis, null, 2));
    return 0;
  }
  renderReport(analysis, options, logger);
  return 0;
}

function bundleHeader(a) {
  return {
    ccVersion: a.ccVersion,
    format: a.format,
    sizeBytes: a.sizeBytes,
    containerBytes: a.containerBytes,
    bundleSha256: a.bundleSha256,
  };
}

function statusGlyph(status) {
  switch (status) {
    case 'resolved': return style.green('resolved');
    case 'missing': return style.red('missing ');
    case 'unresolvable-static': return style.yellow('ast-only');
    default: return status;
  }
}

function renderReport(a, options, logger) {
  logger.log(style.bold('Bundle'));
  logger.log(`  version   ${a.ccVersion ?? '(unset)'}`);
  logger.log(`  format    ${a.format}`);
  logger.log(`  js size   ${a.sizeBytes.toLocaleString()} bytes` +
    (a.containerBytes !== a.sizeBytes ? `  (container ${a.containerBytes.toLocaleString()})` : ''));
  logger.log(`  sha256    ${a.bundleSha256}`);
  if (a.native) {
    logger.log(`  native    entrypoint=${a.native.entrypoint ?? '(none)'} modules=${a.native.moduleCount ?? 0}`);
    if (a.native.error) logger.log(`            ${style.yellow('note:')} ${a.native.error}`);
  }
  logger.log('');

  const idW = Math.max(4, ...a.anchors.map(r => r.id.length));
  const fnW = Math.max(2, ...a.anchors.map(r => (r.fn || '').length));
  logger.log(`${pad('Anchor', idW)}  Status    ${pad('Symbol', fnW)}  Offset:Line`);
  for (const r of a.anchors) {
    const loc = r.offset >= 0 ? `${r.offset}:${r.line}` : '—';
    logger.log(`${pad(r.id, idW)}  ${statusGlyph(r.status)}  ${pad(r.fn || '—', fnW)}  ${loc}`);
    if (options.context > 0 && r.snippet != null) {
      logger.log(style.gray(`    ┄ ${r.snippet.replace(/\n/g, '⏎')}`));
    }
  }

  const resolved = a.anchors.filter(r => r.status === 'resolved').length;
  logger.log('');
  logger.log(`${style.cyan('→')} ${resolved}/${a.anchors.length} anchors resolved` +
    (a.misses.length ? `, ${a.misses.length} miss(es): ${a.misses.join(', ')}` : '') + '.');
}

function renderDiff(diff, prev, next, logger) {
  logger.log(style.bold('Anchor diff') +
    `  ${prev.bundleSha256.slice(0, 12)}… → ${next.bundleSha256.slice(0, 12)}…`);
  logger.log('');
  const order = ['renamed', 'moved', 'vanished', 'appeared', 'stable', 'absent'];
  const rows = diff.rows.slice().sort((x, y) => order.indexOf(x.change) - order.indexOf(y.change));
  const idW = Math.max(6, ...rows.map(r => r.id.length));
  for (const r of rows) {
    let detail = '';
    if (r.change === 'renamed') detail = `${r.from.fn} → ${r.to.fn}`;
    else if (r.change === 'moved') detail = `${r.fn}  Δ${r.offsetDelta > 0 ? '+' : ''}${r.offsetDelta} (${r.from}→${r.to})`;
    else if (r.change === 'vanished') detail = `was ${r.from.fn}@${r.from.offset}`;
    else if (r.change === 'appeared') detail = `now ${r.to.fn}@${r.to.offset}`;
    else if (r.change === 'stable') detail = `${r.fn}@${r.offset}`;
    const tag = {
      renamed: style.yellow('RENAMED '),
      moved: style.yellow('MOVED   '),
      vanished: style.red('VANISHED'),
      appeared: style.green('APPEARED'),
      stable: style.gray('stable  '),
      absent: style.gray('absent  '),
    }[r.change];
    logger.log(`  ${tag}  ${pad(r.id, idW)}  ${detail}`);
  }
  const s = diff.summary;
  logger.log('');
  logger.log(`${style.cyan('→')} stable=${s.stable} moved=${s.moved} renamed=${s.renamed} ` +
    `appeared=${s.appeared} vanished=${s.vanished}.`);
  if (s.moved + s.renamed + s.vanished > 0) {
    logger.log(`${style.cyan('→ Next:')} regenerate the refmap (\`ccpatch refmap\`) and re-run \`ccpatch doctor\`.`);
  }
}

function renderOwnership(a, map, logger) {
  logger.log(style.bold('Anchor ownership') + `  (${a.format}, ${a.ccVersion ?? 'unset'})`);
  logger.log('');
  const idW = Math.max(6, ...map.map(r => r.id.length));
  for (const r of map) {
    if (r.orphan) {
      logger.log(`  ${pad(r.id, idW)}  ${style.yellow('(orphan — no patch references this anchor)')}`);
      continue;
    }
    const owners = r.owners.map(o => `${o.patch} ${style.gray(`(${o.shim})`)}`).join(', ');
    logger.log(`  ${pad(r.id, idW)}  ${owners}`);
  }
  const orphans = map.filter(r => r.orphan).length;
  logger.log('');
  logger.log(`${style.cyan('→')} ${map.length - orphans}/${map.length} anchors owned` +
    (orphans ? `, ${orphans} orphan(s).` : '.'));
}

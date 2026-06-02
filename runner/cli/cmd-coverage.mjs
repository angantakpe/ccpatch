// cmd-coverage.mjs — `ccpatch coverage` handler + tokenizeSmoke, extracted from cli.mjs (#1).

import fs from 'node:fs';
import path from 'node:path';

/**
 * `ccpatch coverage <patched-bundle> [--smoke <cmd>] [--out report.json] [--cc-version X.Y.Z]`
 *
 * Cross-reference apply-time coverage (storage/outputs/coverage-apply-v<ver>.json,
 * written by applyNamedPatches) with runtime hits captured from the bundle.
 *
 * Runtime hits are read via stdin/stdout: the coverage_kernel patch dumps the
 * map on SIGTERM and on process exit, prefixed with "__CCP_COV__". We spawn
 * the bundle (`node patched.js` by default, or the user's --smoke command),
 * scan stdout for the prefix line, and parse the JSON payload.
 *
 * Exits non-zero if any patch is DEAD (applied but never executed).
 */

/**
 * Tokenize a `--smoke` command string into argv parts, honoring single and
 * double quotes so quoted arguments with embedded spaces survive as one token.
 *
 * Rules (deliberately minimal — a smoke command is a program + flags, not a
 * shell pipeline):
 *   - Whitespace outside quotes separates tokens.
 *   - Single quotes preserve their contents verbatim (no escapes inside).
 *   - Double quotes preserve spaces; backslash escapes the next char inside.
 *   - A bare backslash outside quotes escapes the next char.
 * Quote characters themselves are stripped from the emitted tokens. An unclosed
 * quote simply ends the final token (no throw — keeps the smoke path tolerant).
 *
 * @param {string} str
 * @returns {string[]}
 */
export function tokenizeSmoke(str) {
  const tokens = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let started = false; // whether `cur` is an active token (handles empty "")
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; }
      else if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; }
      else cur += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; started = true; continue; }
    if (ch === '"') { inDouble = true; started = true; continue; }
    if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; started = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

export async function runCoverage(options, logger = console) {
  const { spawn } = await import('node:child_process');
  const { bundlePath, smoke, outPath, ccVersion } = options;
  if (!fs.existsSync(bundlePath)) {
    logger.error(`Error: bundle not found: ${bundlePath}`);
    return 2;
  }
  // Locate the apply-time manifest. Try versioned then 'unknown'.
  const candidates = [];
  if (ccVersion) candidates.push(`storage/outputs/coverage-apply-v${ccVersion}.json`);
  candidates.push('storage/outputs/coverage-apply-unknown.json');
  // Fall back: any coverage-apply-*.json in the outputs dir.
  try {
    const dir = 'storage/outputs';
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('coverage-apply-') && f.endsWith('.json')) {
          const full = path.join(dir, f);
          if (!candidates.includes(full)) candidates.push(full);
        }
      }
    }
  } catch (_) { /* non-fatal */ }
  let applyManifest = null;
  let applyManifestPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        applyManifest = JSON.parse(fs.readFileSync(c, 'utf8'));
        applyManifestPath = c;
        break;
      } catch (_) { /* skip */ }
    }
  }
  if (!applyManifest) {
    logger.error('Error: no apply-time coverage manifest found in storage/outputs/. Run apply first.');
    return 2;
  }
  logger.log(`[coverage] apply-time manifest: ${applyManifestPath}`);

  // Spawn the bundle / smoke command and capture stdout.
  let cmd, args;
  if (smoke) {
    // The smoke string is a shell-style command. Tokenize respecting single and
    // double quotes (so `node app.js --flag "a b"` stays 3 tokens, not 4) while
    // stripping the quote characters from the emitted tokens. Backslash escapes
    // the next character outside single quotes (POSIX-ish, intentionally minimal
    // — no env expansion, globbing, or operators).
    const parts = tokenizeSmoke(smoke);
    cmd = parts[0];
    args = parts.slice(1);
    if (!cmd) {
      logger.error('Error: --smoke value is empty');
      return 2;
    }
  } else {
    cmd = process.execPath;
    args = [bundlePath, '--version'];
  }

  logger.log(`[coverage] running: ${cmd} ${args.join(' ')}`);
  const runtimeHits = await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString('utf8'); });
    child.stderr.on('data', () => { /* ignored */ });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Find the last __CCP_COV__ payload in stdout.
      const lines = buf.split('\n');
      let payload = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        const idx = ln.indexOf('__CCP_COV__');
        if (idx !== -1) { payload = ln.slice(idx + '__CCP_COV__'.length); break; }
      }
      let parsed = {};
      if (payload) {
        try { parsed = JSON.parse(payload); } catch (_) { parsed = {}; }
      }
      resolve(parsed);
    };
    child.on('exit', finish);
    child.on('error', () => finish());
    // Hard cap so a hung bundle doesn't wedge the coverage run. Both timers
    // are unref'd so a fast-exiting child closes the event loop immediately.
    const capMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const t1 = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {}; finish(); }, 250);
      t2.unref?.();
    }, capMs);
    t1.unref?.();
  });

  // Cross-reference and build the report.
  const rows = [];
  let deadCount = 0;
  for (const name of Object.keys(applyManifest.patches).sort()) {
    const entry = applyManifest.patches[name];
    const hits = typeof runtimeHits[entry.coverageMarker] === 'number'
      ? runtimeHits[entry.coverageMarker]
      : 0;
    const applied = !!entry.applied;
    const instrumented = !!entry.coverageMarker;
    let status;
    if (!applied) {
      status = 'SKIPPED';
    } else if (!instrumented) {
      status = 'UNINSTRUMENTED';
    } else if (hits > 0) {
      status = 'LIVE';
    } else {
      status = 'DEAD';
      deadCount++;
    }
    rows.push({ name, applied, hits, instrumented, status, marker: entry.coverageMarker ?? null });
  }

  // Print markdown table.
  const headers = ['Patch', 'Applied', 'Hit', 'Status'];
  const widths = [
    Math.max(headers[0].length, ...rows.map(r => r.name.length)),
    headers[1].length,
    headers[2].length,
    Math.max(headers[3].length, ...rows.map(r => r.status.length)),
  ];
  const cell = (s, w) => String(s).padEnd(w);
  logger.log('');
  logger.log(`${cell(headers[0], widths[0])}  ${cell(headers[1], widths[1])}  ${cell(headers[2], widths[2])}  ${cell(headers[3], widths[3])}`);
  logger.log(`${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}  ${'-'.repeat(widths[3])}`);
  for (const r of rows) {
    const appliedStr = r.applied ? 'yes' : 'no';
    const hitStr = r.instrumented ? (r.hits > 0 ? 'yes' : 'no') : '-';
    logger.log(`${cell(r.name, widths[0])}  ${cell(appliedStr, widths[1])}  ${cell(hitStr, widths[2])}  ${cell(r.status, widths[3])}`);
  }
  logger.log('');
  logger.log(`[coverage] ${rows.length} patches, ${deadCount} DEAD`);

  if (outPath) {
    const report = {
      ccVersion: applyManifest.ccVersion ?? null,
      bundlePath,
      runAt: new Date().toISOString(),
      runtimeHits,
      patches: rows,
      deadCount,
    };
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
      logger.log(`[coverage] report written to: ${outPath}`);
    } catch (err) {
      logger.warn(`[coverage] could not write report: ${err.message}`);
    }
  }

  return deadCount > 0 ? 1 : 0;
}

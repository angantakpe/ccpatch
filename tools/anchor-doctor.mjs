#!/usr/bin/env node
/**
 * anchor-doctor.mjs — Patch-agnostic anchor health checker.
 *
 * Loads every patch (core/ + extensions/), runs probeAnchor() against the
 * supplied bundle on a copy of the source, and reports per-patch status:
 *   ok      — apply() would change the code and verify checks pass
 *   drift   — apply() failed to match, but fuzzy candidates exist (re-anchor)
 *   missing — apply() failed and nothing nearby looks like the anchor
 *
 * Writes one anchor-drift.jsonl entry per non-ok patch using the same schema
 * the runner emits (runner/runner.mjs), so CI consumers see a unified stream.
 *
 * Usage:
 *   node tools/anchor-doctor.mjs <path-to-bundle> [--profile <name>] [--json]
 *   node tools/anchor-doctor.mjs releases/2.1.148/cli.v2.1.148.patched.js
 *
 * Exit codes:
 *   0 — every patch ok (or only drift)
 *   1 — at least one patch missing
 *   2 — usage error / cannot read bundle
 */

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

import { loadPatches } from '../runner/loader.mjs';
import { probeAnchor, fuzzyMatch } from '../runner/anchors.mjs';
import { buildProbePatch } from '../runner/effective-apply.mjs';
import { resolveProfile } from '../runner/manifest.mjs';
import { readProfiles } from '../runner/config.mjs';
import { style, icon as glyph, isVerbose } from '../runner/cli/style.mjs';

// Dim, consistent prefix for the doctor's own status lines.
const TAG = style.gray('🩺 anchor doctor');

const args = process.argv.slice(2);
let bundlePath = null;
let profile = null;
let jsonOut = false;
let writeJsonl = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--profile') profile = args[++i];
  else if (a === '--json') jsonOut = true;
  else if (a === '--no-jsonl') writeJsonl = false;
  else if (!bundlePath && !a.startsWith('--')) bundlePath = a;
}

if (!bundlePath) {
  console.error('Usage: node tools/anchor-doctor.mjs <bundle-path> [--profile <name>] [--json]');
  process.exit(2);
}

const absPath = resolve(bundlePath);
let code;
try {
  code = readFileSync(absPath, 'utf8');
} catch (err) {
  console.error(`[anchor_doctor] cannot read file: ${err.message}`);
  process.exit(2);
}

const sha = createHash('sha256').update(code).digest('hex');
const versionMatch = absPath.match(/[v\/-](\d+\.\d+\.\d+)/);
const version = versionMatch ? versionMatch[1] : null;

if (!jsonOut) {
  if (isVerbose()) {
    console.log(`${TAG} ${style.dim('bundle')}  ${absPath}`);
    console.log(`${TAG} ${style.dim('sha256')}  ${sha}`);
    console.log(`${TAG} ${style.dim('size')}    ${(code.length / 1_000_000).toFixed(2)} MB`);
    if (version) console.log(`${TAG} ${style.dim('version')} ${style.cyan(version)}`);
  } else {
    // Compact: one line carrying the facts you act on — which bundle, what
    // version, how big, and a short sha fingerprint. Full path + full sha are a
    // --verbose away (and verify-bundle-sha already printed the full sha above).
    const v = version ? ` ${style.cyan('v' + version)}` : '';
    console.log(
      `${TAG}${v} ${style.dim('·')} ${(code.length / 1_000_000).toFixed(2)} MB ` +
      `${style.dim('·')} ${style.dim('sha')} ${sha.slice(0, 12)}`
    );
  }
}

// ── Load every patch via the runner's own loader so we exercise the real
//    manifest validation + version variant selection.
const patches = await loadPatches(version ? { version } : {});

// Apply profile filter (if requested). Reuse the SAME profile→patch-list
// resolution the build path uses (runner/config.mjs:readProfiles +
// runner/manifest.mjs:resolveProfile) so the doctor pre-pass checks exactly the
// patches the build will apply for that profile — not the full 51-patch catalog.
// The previous hand-rolled YAML scrape produced wrong/inverted counts; this
// resolver is the single source of truth the build already trusts.
// The doctor scans everything by default; --profile narrows the set.
let enabledNames = Object.keys(patches);
if (profile) {
  try {
    const yamlPath = resolve(process.cwd(), 'ccpatch.yml');
    const profiles = readProfiles(yamlPath);
    const { enabled, unknown } = resolveProfile(profile, profiles, enabledNames);
    if (!jsonOut && unknown.length > 0) {
      console.log(`${TAG} profile ${style.cyan(profile)}: ${unknown.length} unknown patch name(s) skipped: ${unknown.join(', ')}`);
    }
    enabledNames = enabled;
    if (!jsonOut) {
      console.log(`${TAG} profile ${style.cyan(profile)} ${style.dim('·')} checking ${style.bold(enabledNames.length)} of ${Object.keys(patches).length} patches`);
    }
  } catch (err) {
    // Unknown profile (or unreadable ccpatch.yml): fail loud rather than
    // silently scanning everything, since a typo'd --profile would otherwise
    // masquerade as a full-catalog pass.
    console.error(`[anchor_doctor] ${err.message}`);
    process.exit(2);
  }
}

// ── Probe ────────────────────────────────────────────────────────────────
const rows = [];
let missingCount = 0;
let driftCount = 0;

for (const name of enabledNames) {
  const patch = patches[name];
  if (!patch) continue;
  // Declarative kinds (prefix/postfix/transpiler) and boot-only patches
  // (bootInject with no apply()) get their effective apply() synthesized by
  // the shared helper, exactly as the runner and `ccpatch doctor` see them.
  const result = probeAnchor(buildProbePatch(patch, name), code);
  rows.push({ name, ...result });
  if (result.status === 'missing') missingCount++;
  else if (result.status === 'drift') driftCount++;
}

// ── Output table ─────────────────────────────────────────────────────────
if (jsonOut) {
  console.log(JSON.stringify({
    bundle: absPath, sha256: sha, version, rows,
    summary: { total: rows.length, missing: missingCount, drift: driftCount },
  }, null, 2));
} else {
  const allOk = missingCount === 0 && driftCount === 0;
  // The full per-patch table is detail: it repeats the patch list the apply
  // phase prints moments later. Show it only when (a) the user asked for detail
  // (--verbose / debug) or (b) something needs attention (drift/missing) — in
  // which case the offending rows are exactly what you want to see. A clean
  // compact run jumps straight to the one-line health summary below.
  const showTable = isVerbose() || !allOk;
  if (showTable) {
    const widthName = Math.max(...rows.map(r => r.name.length), 10);
    // When attention is needed in compact mode, surface ONLY the rows that
    // aren't ok — the healthy 28 are noise; the 1 drifted row is the signal.
    const visibleRows = (isVerbose())
      ? rows
      : rows.filter(r => r.status !== 'ok' || (patches[r.name] && patches[r.name].deprecated));
    console.log();
    console.log(`  ${style.dim('patch'.padEnd(widthName))}   ${style.dim('status   detail')}`);
    console.log(`  ${style.gray('─'.repeat(widthName))}   ${style.gray('───────  ' + '─'.repeat(60))}`);
    // Emoji render two columns wide; the trailing spaces normalize each cell to a
    // consistent on-screen width (⊘ is one column, so it gets an extra pad).
    const icon = { ok: `${glyph.ok} `, drift: `${glyph.drift} `, missing: `${glyph.missing} `, deprecated: `${glyph.deprecated}  ` };
    const paint = { ok: style.green, drift: style.yellow, missing: style.red, deprecated: style.gray };
    for (const r of visibleRows) {
      const patch = patches[r.name];
      if (patch && patch.deprecated) {
        const detail = `deprecated: ${patch.deprecated.reason}${patch.deprecated.since ? ` (since ${patch.deprecated.since})` : ''}`.slice(0, 70);
        console.log(`  ${style.bold(r.name.padEnd(widthName))}  ${icon.deprecated} ${style.gray('deprecated'.padEnd(7))} ${style.dim(detail)}`);
        continue;
      }
      const detail = (r.detail || (r.weak ? 'weak verify (no absent/count)' : '')).slice(0, 70);
      const tint = paint[r.status] ?? style.gray;
      console.log(`  ${style.bold(r.name.padEnd(widthName))}  ${icon[r.status] ?? '?  '} ${tint(r.status.padEnd(7))} ${style.dim(detail)}`);
    }
    console.log();
  }
  const head = allOk ? style.green('🩺 all anchors healthy') : style.yellow('🩺 anchor doctor');
  console.log(`${head} ${style.dim('·')} ${style.bold(rows.length)} patches ${style.dim('|')} ${missingCount ? style.red(missingCount + ' missing') : '0 missing'} ${style.dim('|')} ${driftCount ? style.yellow(driftCount + ' drift') : '0 drift'} ${style.dim('|')} ${style.green((rows.length - missingCount - driftCount) + ' ok')}`);
}

// ── Write drift entries (same schema as runner.mjs) ──────────────────────
if (writeJsonl) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { mkdirSync('storage/outputs', { recursive: true }); } catch { /* ignore */ }
  const outPath = join('storage/outputs', 'anchor-drift.jsonl');
  for (const r of rows) {
    if (r.status === 'ok') continue;
    const patch = patches[r.name];
    const v = patch.verify ?? {};
    const presents = Array.isArray(v.present) ? v.present : (v.present ? [v.present] : []);
    const absents  = Array.isArray(v.absent)  ? v.absent  : (v.absent  ? [v.absent]  : []);
    const declaredLiteral = patch.anchor?.literal ?? null;

    const probes = [];
    if (declaredLiteral) probes.push({ source: 'anchor.literal', value: declaredLiteral });
    for (const p of presents) probes.push({ source: 'verify.present', value: p });
    for (const a of absents)  probes.push({ source: 'verify.absent',  value: a });

    const seen = new Set();
    const candidates = [];
    for (const { source, value } of probes) {
      if (typeof value !== 'string' || value.length < 4) continue;
      const hits = fuzzyMatch(code, new RegExp(escapeRe(value)));
      for (const h of hits) {
        const bucket = Math.floor(h.offset / 50);
        if (seen.has(bucket)) continue;
        seen.add(bucket);
        candidates.push({ source, probe: value.slice(0, 80), offset: h.offset, score: h.score, snippet: h.snippet.slice(0, 120) });
        if (candidates.length >= 3) break;
      }
      if (candidates.length >= 3) break;
    }

    const verifyFailed = [];
    for (const p of presents) if (!code.includes(p)) verifyFailed.push(`verify.present missing: ${p.slice(0, 80)}`);
    for (const a of absents)  if (code.includes(a))  verifyFailed.push(`verify.absent still present: ${a.slice(0, 80)}`);

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: 'anchor-drift',
      source: 'doctor',
      patch: r.name,
      version,
      status: r.status,
      detail: r.detail ?? null,
      anchor: {
        id: r.name,
        literal: declaredLiteral,
        verify_present: presents.map(s => s.slice(0, 80)),
        verify_absent:  absents.map(s => s.slice(0, 80)),
      },
      candidates,
      verify_failed: verifyFailed,
    });
    appendFileSync(outPath, line + '\n', 'utf8');
  }
}

process.exit(missingCount > 0 ? 1 : 0);

// `ccpatch heal` — turn recorded anchor drift into a concrete registry edit.
//
// `ccpatch doctor` (and the apply runner) append anchor-drift signals to
// storage/outputs/anchor-drift.jsonl. `doctor --suggest` already prints fuzzy
// candidates, but stops short of writing anything. `heal` closes the loop: it
// reads that JSONL stream, groups by patch, takes the top-scoring candidate per
// drifted anchor, and proposes a rewritten runner/anchors.mjs registry entry as
// a unified diff. With --write it applies the diff in place.
//
// This module is deliberately pure-ish: the only I/O is reading the JSONL and
// (optionally) reading/writing anchors.mjs as TEXT. It never imports anchors.mjs
// as a module, so it is safe to rewrite the file it depends on. The thin CLI
// wiring lives in runner/cli.mjs.

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from './paths.mjs';

export const DEFAULT_DRIFT_PATH = path.join(PROJECT_ROOT, 'storage', 'outputs', 'anchor-drift.jsonl');
export const DEFAULT_ANCHORS_PATH = path.join(PROJECT_ROOT, 'runner', 'anchors.mjs');

/**
 * Read every drift entry from a JSONL file. Returns a flat array of parsed
 * objects; malformed lines are skipped, and a missing file yields [].
 *
 * @param {string} driftPath
 * @returns {Array<object>}
 */
export function readDrift(driftPath = DEFAULT_DRIFT_PATH) {
  if (!fs.existsSync(driftPath)) return [];
  let txt;
  try { txt = fs.readFileSync(driftPath, 'utf8'); }
  catch (_) { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (_) { /* skip malformed */ }
  }
  return out;
}

/**
 * Group drift entries by patch, keeping the most recent non-ok entry per patch,
 * and pick that entry's highest-scoring candidate.
 *
 * JSONL is append-only, so the "most recent" entry (by `ts`, lexicographic on
 * ISO timestamps) is today's signal. An entry is only healable if it is drifted
 * (status set and != 'ok') AND carries at least one candidate with a usable
 * string probe.
 *
 * @param {Array<object>} entries
 * @returns {Map<string, { entry: object, candidate: object }>} keyed by patch
 */
export function pickTopCandidates(entries) {
  // Latest entry per patch.
  const latest = new Map();
  for (const e of entries) {
    if (!e || !e.patch) continue;
    const prev = latest.get(e.patch);
    if (!prev || (prev.ts || '') < (e.ts || '')) latest.set(e.patch, e);
  }

  const result = new Map();
  for (const [name, entry] of latest) {
    if (!entry.status || entry.status === 'ok') continue;
    const candidate = topCandidate(entry);
    if (!candidate) continue;
    result.set(name, { entry, candidate });
  }
  return result;
}

/**
 * Return the highest-scoring candidate from a drift entry that carries a usable
 * string token (probe preferred, snippet as fallback). Returns null when the
 * entry has no candidate we can turn into a literal.
 */
function topCandidate(entry) {
  const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
  let best = null;
  for (const c of candidates) {
    if (!c) continue;
    const token = candidateToken(c);
    if (!token) continue;
    const score = typeof c.score === 'number' ? c.score : -Infinity;
    if (!best || score > best.score) best = { ...c, score };
  }
  return best;
}

/**
 * Derive the stable string token a candidate proposes as the new anchor
 * literal. Prefer the `probe` (the exact verify/anchor string the doctor
 * searched for), falling back to a trimmed snippet. Returns null if neither
 * yields a non-trivial string.
 */
function candidateToken(candidate) {
  const probe = typeof candidate.probe === 'string' ? candidate.probe.trim() : '';
  if (probe.length >= 4) return probe;
  const snippet = typeof candidate.snippet === 'string' ? candidate.snippet.trim() : '';
  if (snippet.length >= 4) return snippet;
  return null;
}

/**
 * The registry key an entry targets. Drift entries record the anchor under
 * `anchor.id`; fall back to the patch name (they coincide for registry-backed
 * patches).
 */
function anchorIdFor(entry) {
  return (entry.anchor && entry.anchor.id) || entry.patch || null;
}

/**
 * Rewrite the `literal:` field of a single anchor registry entry inside the
 * anchors.mjs source text. Returns the new source, or null if the anchor block
 * (or its literal line) could not be located.
 *
 * We operate on text (not the parsed module) precisely so heal can rewrite the
 * file it would otherwise import. The match is scoped to the `<id>: {` block so
 * we never touch a literal belonging to a different anchor.
 *
 * @param {string} src      anchors.mjs source
 * @param {string} id       registry key, e.g. 'isDurableCronEnabled'
 * @param {string} literal  the new literal string value
 * @returns {string|null}
 */
export function rewriteAnchorLiteral(src, id, literal) {
  const escId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Find the opening of the `<id>: {` block.
  const blockOpen = new RegExp(`(^|\\n)(\\s*)${escId}:\\s*\\{`);
  const openMatch = blockOpen.exec(src);
  if (!openMatch) return null;
  const blockStart = openMatch.index + openMatch[1].length;

  // Find the matching closing brace by scanning depth from the `{`.
  const braceIdx = src.indexOf('{', blockStart);
  if (braceIdx === -1) return null;
  let depth = 0;
  let blockEnd = -1;
  for (let i = braceIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { blockEnd = i; break; }
    }
  }
  if (blockEnd === -1) return null;

  const block = src.slice(blockStart, blockEnd + 1);
  const newValue = JSON.stringify(literal);

  // Replace an existing `literal: '...'` / "..." within the block. Capture the
  // indentation + key so the rewrite is byte-aligned with the original.
  const litRe = /(\n\s*literal:\s*)(['"])(?:\\.|(?!\2).)*\2/;
  let newBlock;
  if (litRe.test(block)) {
    newBlock = block.replace(litRe, `$1${newValue}`);
  } else {
    // No literal yet — insert one as the first field after `{`.
    const indentMatch = /\n(\s*)\S/.exec(block.slice(block.indexOf('{') + 1));
    const indent = indentMatch ? indentMatch[1] : '    ';
    newBlock = block.replace(/\{/, `{\n${indent}literal: ${newValue},`);
  }
  if (newBlock === block) return null;
  return src.slice(0, blockStart) + newBlock + src.slice(blockEnd + 1);
}

/**
 * Produce a unified diff (and the rewritten source) that heals every drifted
 * anchor with a top candidate. Anchors whose id is not present in the registry
 * source are reported as `skipped` rather than failing.
 *
 * @param {Array<object>} entries     drift entries (from readDrift)
 * @param {string}        anchorsSrc  current runner/anchors.mjs source text
 * @param {object}        [opts]
 * @param {string}        [opts.fileLabel='runner/anchors.mjs'] label for the diff header
 * @returns {{ diff: string, newSrc: string, changes: Array<{patch,id,literal}>, skipped: Array<{patch,id,reason}> }}
 */
export function proposeHeal(entries, anchorsSrc, opts = {}) {
  const fileLabel = opts.fileLabel || 'runner/anchors.mjs';
  const picks = pickTopCandidates(entries);

  let newSrc = anchorsSrc;
  const changes = [];
  const skipped = [];

  // Deterministic order: by patch name.
  for (const name of [...picks.keys()].sort()) {
    const { entry, candidate } = picks.get(name);
    const id = anchorIdFor(entry);
    if (!id) { skipped.push({ patch: name, id: null, reason: 'no anchor id' }); continue; }
    const literal = candidateToken(candidate);
    if (!literal) { skipped.push({ patch: name, id, reason: 'no usable candidate token' }); continue; }
    const rewritten = rewriteAnchorLiteral(newSrc, id, literal);
    if (rewritten == null) {
      skipped.push({ patch: name, id, reason: 'anchor not found in registry' });
      continue;
    }
    if (rewritten === newSrc) {
      skipped.push({ patch: name, id, reason: 'literal already up to date' });
      continue;
    }
    newSrc = rewritten;
    changes.push({ patch: name, id, literal });
  }

  const diff = newSrc === anchorsSrc
    ? ''
    : makeUnifiedDiff(fileLabel, anchorsSrc, newSrc);

  return { diff, newSrc, changes, skipped };
}

/**
 * Minimal dependency-free unified diff for the (typically tiny) registry edits
 * heal makes. Emits only changed hunks with 3 lines of context, matching the
 * common `diff -u` shape closely enough to paste or `patch`-apply.
 */
function makeUnifiedDiff(label, oldStr, newStr, context = 3) {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  // Trim common prefix / suffix to isolate the changed region.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(a.length - 1, endA + context);
  const ctxEndB = Math.min(b.length - 1, endB + context);

  const header =
    `--- a/${label}\n` +
    `+++ b/${label}\n`;

  const oldCount = ctxEndA - ctxStart + 1;
  const newCount = ctxEndB - ctxStart + 1;
  const hunkHeader = `@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@\n`;

  const body = [];
  for (let i = ctxStart; i < start; i++) body.push(' ' + a[i]);
  for (let i = start; i <= endA; i++) body.push('-' + a[i]);
  for (let i = start; i <= endB; i++) body.push('+' + b[i]);
  for (let i = endA + 1; i <= ctxEndA; i++) body.push(' ' + a[i]);

  return header + hunkHeader + body.join('\n') + '\n';
}

/**
 * High-level orchestration for the CLI. Reads the drift JSONL + anchors source,
 * computes the proposal, and (when write) applies it. Returns a result the CLI
 * renders. Pure aside from the file reads/writes it is explicitly asked to do.
 *
 * @param {object} opts
 * @param {string} [opts.driftPath]   path to anchor-drift.jsonl
 * @param {string} [opts.anchorsPath] path to runner/anchors.mjs
 * @param {boolean}[opts.write]       apply the diff in place
 * @returns {{ ok: boolean, error?: string, diff: string, changes, skipped, wrote: boolean }}
 */
export function runHeal(opts = {}) {
  const driftPath = opts.driftPath || DEFAULT_DRIFT_PATH;
  const anchorsPath = opts.anchorsPath || DEFAULT_ANCHORS_PATH;

  if (!fs.existsSync(anchorsPath)) {
    return { ok: false, error: `anchors registry not found: ${anchorsPath}`, diff: '', changes: [], skipped: [], wrote: false };
  }
  const entries = readDrift(driftPath);
  const anchorsSrc = fs.readFileSync(anchorsPath, 'utf8');
  const fileLabel = path.relative(PROJECT_ROOT, anchorsPath) || path.basename(anchorsPath);
  const { diff, newSrc, changes, skipped } = proposeHeal(entries, anchorsSrc, { fileLabel });

  let wrote = false;
  if (opts.write && diff) {
    fs.writeFileSync(anchorsPath, newSrc, 'utf8');
    wrote = true;
  }
  return { ok: true, diff, changes, skipped, wrote, empty: diff === '', driftCount: entries.length };
}

// Batched verifier — a thin composition over the verify-core kernel.
//
// The legacy per-patch checkVerify() re-walks the entire bundle once for every
// `verify.present` / `verify.absent` literal — with ~90 enabled patches each
// declaring 1–2 strings, that's ~180 full bundle scans per build (cli.js is
// ~10MB so this is genuinely measurable). verifyBatch collapses all of those
// scans into one pass over the code string.
//
// Task 1 (dedup): the literal bucketing/scan algorithm used to live HERE and
// mirror verify-core's matching; it now lives in verify-core.mjs as
// scanOccurrences() (the multi-literal form of the findOccurrences kernel)
// and this module only composes it:
//   1. union the unique non-empty literals across every item,
//   2. scanOccurrences(code, literals) → Map<literal, offsets> (ONE scan),
//   3. checkVerifyCore(item, code, { positions }) per item — the recorded
//      offsets satisfy present/absent/count without re-scanning, and the
//      'default' style keeps the issue strings byte-identical to checkVerify.

import { checkVerifyCore, toList, scanOccurrences } from './verify-core.mjs';

/**
 * Run all per-patch verify assertions in a single pass over `code`.
 *
 * Returns an array shaped `[{ name, issues: string[] }]`, with one entry per
 * input item (issues empty when the patch passed). Mirrors checkVerify()'s
 * issue strings so callers can route them unchanged.
 *
 * @param {string} code
 * @param {Array<{patchName: string, present?: string[]|string, absent?: string[]|string, count?: any}>} items
 * @returns {Array<{ name: string, issues: string[] }>}
 */
export function verifyBatch(code, items) {
  const norm = items.map((it) => ({
    name: it.patchName,
    present: toList(it.present).filter((s) => typeof s === 'string' && s.length > 0),
    absent:  toList(it.absent).filter((s) => typeof s === 'string' && s.length > 0),
    count: it.count,
  }));

  const uniq = new Set();
  for (const it of norm) {
    for (const s of it.present) uniq.add(s);
    for (const s of it.absent) uniq.add(s);
  }
  const positions = uniq.size > 0 ? scanOccurrences(code, uniq) : new Map();

  const out = [];
  for (const it of norm) {
    const issues = checkVerifyCore(it, code, { positions, style: 'default' });
    out.push({ name: it.name, issues });
  }
  return out;
}

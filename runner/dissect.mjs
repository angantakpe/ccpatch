/**
 * runner/dissect.mjs — Structural analysis of a Claude Code bundle.
 *
 * This is the shared primitive behind `ccpatch dissect` AND `ccpatch refmap`.
 * Both render the SAME `analyzeBundle()` model so the two can never drift —
 * the same discipline `explain` follows by reusing `resolveEffectivePatches()`.
 *
 *   analyzeBundle(input, opts)  → structural model (anchors, misses, native)
 *   diffAnalyses(oldA, newA)    → per-anchor stable|moved|renamed|vanished|appeared
 *   buildOwnershipMap(analysis) → anchor → owning patch → core/extensions shim
 *
 * The functions here are pure with respect to their inputs: `analyzeBundle`
 * does the one unavoidable read (the bundle bytes) when handed a path, but
 * accepts a pre-read `{ code }` / `{ buffer }` for fully I/O-free use in tests.
 * No timestamps, no writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { anchors } from './anchors.mjs';
import { findFunctionByLiteral } from './ast-anchor.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import { parseModules, getModuleSlice, ELF_MAGIC } from '../tools/bun-decompiler/decompile.mjs';

// Mach-O magic numbers (thin slices only; fat/universal is reported but not
// dissected — same boundary the native repack path draws).
const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit  LE
  0xfeedfacf, // 64-bit  LE
  0xcefaedfe, // 32-bit  BE (byteswapped)
  0xcffaedfe, // 64-bit  BE (byteswapped)
]);
const MACHO_FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca]);

/**
 * Classify a buffer's container format from its leading bytes.
 * @returns {'js'|'elf'|'macho'|'macho-fat'|'unknown'}
 */
export function detectFormat(buffer) {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ELF_MAGIC)) return 'elf';
  if (buffer.length >= 4) {
    const m = buffer.readUInt32BE(0);
    if (MACHO_FAT_MAGICS.has(m)) return 'macho-fat';
    if (MACHO_MAGICS.has(m)) return 'macho';
  }
  // Heuristic: a Bun-compiled binary embeds the bunfs marker even when the
  // outer container is something we don't fingerprint above.
  if (buffer.includes('/$bunfs/')) return 'macho'; // best-effort: treat as native
  return 'js';
}

/**
 * Convert a byte offset into a 1-based line number within `code`.
 * Bundles are effectively single-line minified, so this is usually 1 — but
 * for non-minified inputs (tests, fixtures) it gives a real line.
 */
export function lineAtOffset(code, offset) {
  if (offset < 0 || offset > code.length) return -1;
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * The set of registry anchor ids in stable (sorted) order. Exposed so callers
 * that want "every anchor we know about" don't reach into anchors.mjs directly.
 */
export function anchorIds() {
  return Object.keys(anchors).sort();
}

/**
 * Extract the embedded entrypoint JS from a native (Bun SEA) binary.
 * Reuses the public decompiler primitives — never the repack/offset-rewrite
 * half, which dissect (read-only) must not touch.
 *
 * @returns {{ code: string, native: object } | null} null when no JS module found.
 */
function extractNativeEntrypoint(buffer) {
  let parsed;
  try {
    parsed = parseModules(buffer);
  } catch (err) {
    return { code: '', native: { format: detectFormat(buffer), error: err.message, modules: [] } };
  }
  const { modules, markerCount, rawCount } = parsed;
  const jsModules = modules.filter(m => m.kind === 'js');
  // Same selection order repack-bundle.mjs:findJsRegion uses — prefer the
  // entrypoint cli.js, fall back to any cli.js, then any js module.
  const cli =
    jsModules.find(m => /(^|\/)cli\.js$/.test(m.path) && m.path.includes('entrypoint')) ||
    jsModules.find(m => /(^|\/)cli\.js$/.test(m.path)) ||
    jsModules[0] ||
    null;

  const native = {
    format: detectFormat(buffer),
    markerCount,
    rawCount,
    entrypoint: cli ? cli.path : null,
    moduleCount: modules.length,
    modules: modules.map(m => ({
      path: m.path,
      kind: m.kind,
      offset: m.contentStart,
      byteLen: m.contentLength,
    })),
  };

  if (!cli) return { code: '', native };
  const slice = getModuleSlice(buffer, cli, { unwrap: false });
  return { code: slice.toString('utf8'), native };
}

/**
 * Resolve every registry anchor against bundle `code`, returning a sorted
 * array of per-anchor structural records.
 */
function resolveAnchorsIn(code, { context = 0 } = {}) {
  const rows = [];
  const misses = [];
  for (const id of anchorIds()) {
    const entry = anchors[id] || {};
    const literal = entry.literal ?? null;
    // Anchors without a stable literal are AST/regex-shape anchors that cannot
    // be resolved statically here. Report them honestly rather than dropping
    // them — silent omission would make the report lie.
    if (!literal) {
      const row = {
        id, literal: null, kind: 'ast',
        fn: null, offset: -1, line: -1,
        status: 'unresolvable-static',
      };
      if (context > 0) row.snippet = null;
      rows.push(row);
      misses.push(id);
      continue;
    }
    const hit = findFunctionByLiteral(code, literal);
    if (!hit) {
      const row = {
        id, literal, kind: 'literal',
        fn: null, offset: -1, line: -1,
        status: 'missing',
      };
      if (context > 0) row.snippet = null;
      rows.push(row);
      misses.push(id);
      continue;
    }
    const row = {
      id, literal, kind: 'literal',
      fn: hit.name, offset: hit.start, line: lineAtOffset(code, hit.start),
      status: 'resolved',
    };
    if (context > 0) {
      const from = Math.max(0, hit.start - context);
      const to = Math.min(code.length, hit.start + context);
      row.snippet = code.slice(from, to);
    }
    rows.push(row);
  }
  return { anchors: rows, misses };
}

/**
 * Analyze a bundle. Accepts a filesystem path, or a pre-read `{ code }`
 * (plain JS) / `{ buffer }` (possibly native) for I/O-free use.
 *
 * @param {string | { code?: string, buffer?: Buffer }} input
 * @param {{ ccVersion?: string|null, context?: number, native?: boolean }} [opts]
 *   context  — chars of source to capture around each resolved anchor (0 = none)
 *   native   — force native extraction even if the input parses as JS
 * @returns {{
 *   ccVersion: string|null,
 *   format: 'js'|'elf'|'macho'|'macho-fat'|'unknown',
 *   sizeBytes: number,
 *   bundleSha256: string,
 *   anchors: Array<object>,
 *   misses: string[],
 *   native: object|null,
 * }}
 */
export function analyzeBundle(input, opts = {}) {
  const ccVersion = opts.ccVersion ?? null;
  const context = Number.isFinite(opts.context) ? Math.max(0, opts.context | 0) : 0;

  let buffer = null;
  let code = null;
  if (typeof input === 'string') {
    buffer = fs.readFileSync(input);
  } else if (input && input.buffer) {
    buffer = input.buffer;
  } else if (input && typeof input.code === 'string') {
    code = input.code;
  } else {
    throw new TypeError('analyzeBundle: input must be a path, { code }, or { buffer }');
  }

  let native = null;
  if (code == null) {
    const format = detectFormat(buffer);
    const wantNative = opts.native || format !== 'js';
    if (wantNative && format !== 'js') {
      if (format === 'macho-fat') {
        // Fat/universal Mach-O: report, don't dissect (mirror repack's boundary).
        native = { format, error: 'fat/universal Mach-O — thin to a single slice first', modules: [] };
        code = '';
      } else {
        const extracted = extractNativeEntrypoint(buffer);
        native = extracted.native;
        code = extracted.code;
      }
    } else {
      code = buffer.toString('utf8');
    }
  }

  // sizeBytes + sha describe the ANALYZED JS, not the outer container — for a
  // native binary that's the extracted entrypoint, so the sha matches what the
  // plain-JS path would produce for the same embedded module. containerBytes
  // carries the on-disk size when it differs (native).
  const bundleSha256 = createHash('sha256').update(code, 'utf8').digest('hex');
  const sizeBytes = Buffer.byteLength(code, 'utf8');
  const containerBytes = buffer ? buffer.length : sizeBytes;
  const { anchors: anchorRows, misses } = resolveAnchorsIn(code, { context });

  return {
    ccVersion,
    format: native ? native.format : 'js',
    sizeBytes,
    containerBytes,
    bundleSha256,
    anchors: anchorRows,
    misses,
    native,
  };
}

/**
 * Project an analysis into the legacy refmap shape so build-refmap.mjs and the
 * on-disk refmaps/*.json format stay byte-identical. `generatedAt` is the
 * caller's concern (kept out of the pure path).
 *
 * @returns {{ ccVersion, bundleSha256, anchors: Record<string,{fn,offset}>, misses: string[] }}
 */
export function analysisToRefmap(analysis) {
  const resolved = {};
  const misses = [];
  for (const a of analysis.anchors) {
    if (a.status === 'resolved') resolved[a.id] = { fn: a.fn, offset: a.offset };
    else misses.push(a.id);
  }
  // Stable order for misses (the registry walk is already sorted, but a caller
  // may have filtered) — keep deterministic for --check equality.
  misses.sort();
  return {
    ccVersion: analysis.ccVersion ?? null,
    bundleSha256: analysis.bundleSha256,
    anchors: resolved,
    misses,
  };
}

/**
 * Diff two analyses by anchor id. Classifies each id present in EITHER:
 *   stable   — resolved in both, same fn + offset
 *   moved    — resolved in both, same fn, offset changed (offsetDelta)
 *   renamed  — resolved in both, fn changed
 *   appeared — resolved in `next`, not resolved in `prev`
 *   vanished — resolved in `prev`, not resolved in `next`
 *   absent   — unresolved in both (carried for completeness; usually filtered)
 *
 * @returns {{ summary: Record<string,number>, rows: Array<object> }}
 */
export function diffAnalyses(prev, next) {
  const byId = (a) => new Map(a.anchors.map(r => [r.id, r]));
  const p = byId(prev);
  const n = byId(next);
  const ids = Array.from(new Set([...p.keys(), ...n.keys()])).sort();

  const rows = [];
  const summary = { stable: 0, moved: 0, renamed: 0, appeared: 0, vanished: 0, absent: 0 };
  for (const id of ids) {
    const a = p.get(id);
    const b = n.get(id);
    const aOk = a && a.status === 'resolved';
    const bOk = b && b.status === 'resolved';
    let change;
    const row = { id };
    if (aOk && bOk) {
      if (a.fn !== b.fn) {
        change = 'renamed';
        row.from = { fn: a.fn, offset: a.offset };
        row.to = { fn: b.fn, offset: b.offset };
      } else if (a.offset !== b.offset) {
        change = 'moved';
        row.fn = a.fn;
        row.offsetDelta = b.offset - a.offset;
        row.from = a.offset;
        row.to = b.offset;
      } else {
        change = 'stable';
        row.fn = a.fn;
        row.offset = a.offset;
      }
    } else if (!aOk && bOk) {
      change = 'appeared';
      row.to = { fn: b.fn, offset: b.offset };
    } else if (aOk && !bOk) {
      change = 'vanished';
      row.from = { fn: a.fn, offset: a.offset };
    } else {
      change = 'absent';
    }
    row.change = change;
    summary[change]++;
    rows.push(row);
  }
  return { summary, rows };
}

/**
 * Best-effort: which patch shim(s) reference a given anchor id. Patches resolve
 * anchors by id inside their core/ or extensions/ source (e.g.
 * `resolveAnchor('isDurableCronEnabled', …)`), so the source grep is the
 * authoritative join — there is no central anchor→patch table. The filename
 * stem is the patch name.
 *
 * @param {string} id
 * @param {string} [root]
 * @returns {Array<{ patch: string, shim: string }>}  empty = orphan anchor
 */
export function ownersOfAnchor(id, root = PROJECT_ROOT) {
  const owners = [];
  for (const sub of ['core', 'extensions']) {
    const dir = path.join(root, sub);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.mjs')) continue;
      const full = path.join(dir, f);
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (text.includes(id)) {
        owners.push({ patch: f.replace(/\.mjs$/, ''), shim: path.relative(root, full) });
      }
    }
  }
  return owners;
}

/**
 * Join an analysis's anchors to their owning patch/shim. Anchors with no
 * referencing source are flagged `orphan: true` — a real signal (e.g. an
 * anchor registered but not yet wired to any patch).
 *
 * @returns {Array<{ id, status, fn, offset, owners, orphan }>}
 */
export function buildOwnershipMap(analysis, root = PROJECT_ROOT) {
  return analysis.anchors.map(a => {
    const owners = ownersOfAnchor(a.id, root);
    return {
      id: a.id,
      status: a.status,
      fn: a.fn,
      offset: a.offset,
      owners,
      orphan: owners.length === 0,
    };
  });
}

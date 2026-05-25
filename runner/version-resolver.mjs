/**
 * Per-upstream-version patch directory resolver.
 *
 * Layout:
 *   core/
 *     fix_bun_shim.mjs                 # default / fallback
 *     fix_bun_shim/
 *       2.1.148.mjs                    # used when bundle is exactly 2.1.148
 *       >=2.1.150.mjs                  # used when bundle is >= 2.1.150
 *       >=2.1.150,<2.2.0.mjs           # range with both bounds
 *
 * Resolution:
 *   1. If <name>/ directory exists, scan for files whose stems are either:
 *        - exact version "X.Y.Z.mjs"
 *        - range expressions: ">=X.Y.Z.mjs", "<X.Y.Z.mjs", ">=X.Y.Z,<A.B.C.mjs"
 *   2. Select the most specific match:
 *        - Exact match wins.
 *        - Otherwise the narrowest matching range (highest lower bound).
 *   3. Fall back to <name>.mjs (default).
 *   4. If <name>.mjs is absent and no range matches, that's a load error.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Parse a dotted-numeric version string into a normalised int array. */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const parts = v.trim().split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

/** Compare two version arrays (or strings). Returns -1 | 0 | 1, null on parse failure. */
export function compareVersions(a, b) {
  const pa = Array.isArray(a) ? a : parseVersion(a);
  const pb = Array.isArray(b) ? b : parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Parse a version-variant stem (filename without .mjs).
 * Returns one of:
 *   { kind: 'exact',  version: '2.1.148' }
 *   { kind: 'range',  gte?: '2.1.150', lt?: '2.2.0' }
 *   null  (unparseable; caller decides whether to ignore or error)
 *
 * Accepted stems:
 *   "2.1.148"
 *   ">=2.1.150"
 *   "<2.2.0"
 *   ">=2.1.150,<2.2.0"
 */
export function parseVariantStem(stem) {
  if (typeof stem !== 'string' || !stem.trim()) return null;
  const s = stem.trim();

  // Exact version (purely dotted numeric)
  if (/^\d+(\.\d+)*$/.test(s)) {
    if (!parseVersion(s)) return null;
    return { kind: 'exact', version: s };
  }

  // Range expression: comma-separated list of >=X or <X clauses.
  const clauses = s.split(',').map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return null;
  let gte;
  let lt;
  for (const c of clauses) {
    const mGte = c.match(/^>=\s*(\d+(?:\.\d+)*)$/);
    const mLt = c.match(/^<\s*(\d+(?:\.\d+)*)$/);
    if (mGte) {
      if (gte !== undefined) return null; // duplicate >=
      gte = mGte[1];
    } else if (mLt) {
      if (lt !== undefined) return null; // duplicate <
      lt = mLt[1];
    } else {
      return null;
    }
  }
  if (gte === undefined && lt === undefined) return null;
  // Sanity: if both, gte < lt
  if (gte !== undefined && lt !== undefined) {
    const cmp = compareVersions(gte, lt);
    if (cmp === null || cmp >= 0) return null;
  }
  const out = { kind: 'range' };
  if (gte !== undefined) out.gte = gte;
  if (lt !== undefined) out.lt = lt;
  return out;
}

/** Does the given version satisfy a parsed variant? */
export function variantMatches(parsed, version) {
  if (!parsed || !version) return false;
  if (parsed.kind === 'exact') {
    return compareVersions(parsed.version, version) === 0;
  }
  if (parsed.kind === 'range') {
    if (parsed.gte !== undefined) {
      const c = compareVersions(version, parsed.gte);
      if (c === null || c < 0) return false;
    }
    if (parsed.lt !== undefined) {
      const c = compareVersions(version, parsed.lt);
      if (c === null || c >= 0) return false;
    }
    return true;
  }
  return false;
}

/**
 * Among matching variants, pick the most specific:
 *   - exact wins over any range
 *   - among ranges, narrowest = highest gte (ties broken by lowest lt)
 */
export function pickBestVariant(variants, version) {
  const matching = variants.filter((v) => variantMatches(v.parsed, version));
  if (matching.length === 0) return null;

  const exact = matching.find((v) => v.parsed.kind === 'exact');
  if (exact) return exact;

  // Sort ranges by narrowness: highest gte first; if equal, lowest lt first.
  matching.sort((a, b) => {
    const aGte = a.parsed.gte ?? '0.0.0';
    const bGte = b.parsed.gte ?? '0.0.0';
    const c = compareVersions(bGte, aGte); // descending
    if (c !== 0 && c !== null) return c;
    const aLt = a.parsed.lt ?? '9999.9999.9999';
    const bLt = b.parsed.lt ?? '9999.9999.9999';
    return compareVersions(aLt, bLt) ?? 0; // ascending
  });
  return matching[0];
}

/**
 * Scan a per-version directory for variants. Returns an array of
 *   { stem, parsed, filePath }
 * Skips files starting with "_" or "." and any file whose stem isn't a valid variant.
 */
export function scanVariantDir(dirPath) {
  const entries = fs.readdirSync(dirPath);
  const variants = [];
  for (const entry of entries) {
    if (!entry.endsWith('.mjs')) continue;
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const stem = entry.slice(0, -'.mjs'.length);
    const parsed = parseVariantStem(stem);
    if (!parsed) {
      // Unparseable stem in a version dir is an authoring error.
      throw new Error(
        `Per-version patch file has unparseable version stem: ${path.join(dirPath, entry)}\n` +
        `  Expected one of: "X.Y.Z", ">=X.Y.Z", "<X.Y.Z", ">=X.Y.Z,<A.B.C"`
      );
    }
    variants.push({ stem, parsed, filePath: path.join(dirPath, entry) });
  }
  return variants;
}

/**
 * Resolve which file to load for a given patch name in a given directory.
 *
 * @param {string} dir          - directory containing <name>.mjs and optionally <name>/
 * @param {string} name         - patch name (stem)
 * @param {string} [version]    - target bundle version (e.g. "2.1.148")
 * @returns {{ filePath: string, variant: string }}  variant is 'default' or the stem
 * @throws if neither default nor a matching variant exists
 */
export function resolvePatchFile(dir, name, version) {
  const defaultFile = path.join(dir, name + '.mjs');
  const variantDir = path.join(dir, name);
  const hasDefault = fs.existsSync(defaultFile);
  const hasVariantDir = fs.existsSync(variantDir) && fs.statSync(variantDir).isDirectory();

  if (hasVariantDir) {
    const variants = scanVariantDir(variantDir);
    if (variants.length > 0 && version) {
      const best = pickBestVariant(variants, version);
      if (best) return { filePath: best.filePath, variant: best.stem };
    }
  }

  if (hasDefault) return { filePath: defaultFile, variant: 'default' };

  if (hasVariantDir) {
    throw new Error(
      `Patch "${name}": no default ${name}.mjs and no version variant matches ${version ?? '(no version supplied)'}\n` +
      `  Searched: ${variantDir}`
    );
  }
  throw new Error(`Patch "${name}": file not found at ${defaultFile}`);
}

/**
 * Enumerate all patch names available in a directory: union of <name>.mjs files
 * (excluding underscore-prefixed) and <name>/ variant directories.
 *
 * Returns array of { name, hasDefault, hasVariantDir, variantDir }.
 */
export function enumeratePatchNames(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const names = new Map();
  for (const ent of entries) {
    if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
    if (ent.isFile() && ent.name.endsWith('.mjs')) {
      const stem = ent.name.slice(0, -'.mjs'.length);
      const cur = names.get(stem) ?? { name: stem, hasDefault: false, hasVariantDir: false };
      cur.hasDefault = true;
      names.set(stem, cur);
    } else if (ent.isDirectory()) {
      const cur = names.get(ent.name) ?? { name: ent.name, hasDefault: false, hasVariantDir: false };
      cur.hasVariantDir = true;
      cur.variantDir = path.join(dir, ent.name);
      names.set(ent.name, cur);
    }
  }
  return [...names.values()];
}

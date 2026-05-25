#!/usr/bin/env node

/**
 * tweakcc-anchors — Anchor Catalog Builder
 *
 * Reads every system prompt file from ~/.tweakcc/system-prompts/, extracts
 * stable anchor substrings from each, and greps the target bundle to produce
 * a catalog: prompt name → { line, char offset, anchor text }.
 *
 * Use the catalog to:
 *   - Know exactly where any Anthropic system prompt lives in the minified bundle
 *   - Write patch-cli.mjs anchors with confidence instead of guessing
 *   - Detect which prompts changed between CC releases (hash diff)
 *
 * Usage:
 *   node src/cli/tweakcc-anchors.mjs [options]
 *
 * Options:
 *   --bundle <path>    Bundle to scan (default: latest cli.v*.patched.js in cwd)
 *   --prompts <dir>    tweakcc system-prompts dir (default: ~/.tweakcc/system-prompts)
 *   --hashes <path>    tweakcc hashes file (default: ~/.tweakcc/systemPromptOriginalHashes.json)
 *   --out <path>       Write JSON catalog to this path (default: storage/outputs/anchor-catalog.json)
 *   --filter <glob>    Only process files matching this pattern (e.g. "agent-prompt-*")
 *   --changed          Only show prompts whose hash differs from the hashes file (version drift)
 *   --missing          Only show prompts not found in the bundle
 *   --json             Output JSON only (no table)
 *   --no-color         Disable color output
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const CWD = process.cwd();

// ─── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    bundle:    { type: 'string' },
    prompts:   { type: 'string' },
    hashes:    { type: 'string' },
    out:       { type: 'string' },
    filter:    { type: 'string' },
    changed:   { type: 'boolean', default: false },
    missing:   { type: 'boolean', default: false },
    json:      { type: 'boolean', default: false },
    'no-color':{ type: 'boolean', default: false },
  },
  strict: false,
});

const USE_COLOR = !args['no-color'] && process.stdout.isTTY;
const c = {
  reset:  USE_COLOR ? '\x1b[0m'  : '',
  bold:   USE_COLOR ? '\x1b[1m'  : '',
  dim:    USE_COLOR ? '\x1b[2m'  : '',
  green:  USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  cyan:   USE_COLOR ? '\x1b[36m' : '',
  red:    USE_COLOR ? '\x1b[31m' : '',
  gray:   USE_COLOR ? '\x1b[90m' : '',
};

// ─── Resolve paths ───────────────────────────────────────────────────────────

const PROMPTS_DIR = args.prompts
  ? path.resolve(args.prompts)
  : path.join(os.homedir(), '.tweakcc', 'system-prompts');

const HASHES_PATH = args.hashes
  ? path.resolve(args.hashes)
  : path.join(os.homedir(), '.tweakcc', 'systemPromptOriginalHashes.json');

const OUT_PATH = args.out
  ? path.resolve(args.out)
  : path.join(CWD, 'storage', 'outputs', 'anchor-catalog.json');

// Auto-detect bundle: prefer unpatched archives, fall back to patched
function detectBundle() {
  if (args.bundle) return path.resolve(args.bundle);
  // Look for patched bundles in cwd
  const patched = fs.readdirSync(CWD)
    .filter(f => /^cli\.v[\d.]+\.patched\.js$/.test(f))
    .sort()
    .reverse();
  if (patched.length) return path.join(CWD, patched[0]);
  throw new Error('No bundle found. Pass --bundle <path> or run from the ccpatch directory.');
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────

/**
 * Parse a tweakcc system prompt file.
 * Frontmatter is an HTML comment block:
 *   <!--
 *   name: 'Foo'
 *   description: ...
 *   ccVersion: 2.1.84
 *   variables:
 *     - VAR_NAME
 *   -->
 *
 * Returns { name, description, ccVersion, variables, body }
 */
function parsePromptFile(content) {
  const fmMatch = content.match(/^<!--\s*([\s\S]*?)-->\s*/);
  if (!fmMatch) return { name: null, description: null, ccVersion: null, variables: [], body: content.trim() };

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length).trim();

  const get = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    if (!m) return null;
    return m[1].replace(/^['"]|['"]$/g, '').trim();
  };

  const vars = [];
  const varSection = fm.match(/^variables:\s*\n((?:\s+-[^\n]+\n?)*)/m);
  if (varSection) {
    for (const line of varSection[1].split('\n')) {
      const v = line.match(/^\s+-\s+(\w+)/);
      if (v) vars.push(v[1]);
    }
  }

  return {
    name: get('name'),
    description: get('description'),
    ccVersion: get('ccVersion'),
    variables: vars,
    body,
  };
}

// ─── Anchor extraction ────────────────────────────────────────────────────────

const MIN_ANCHOR_LEN = 45;
const MAX_ANCHOR_LEN = 90;
const ANCHORS_PER_PROMPT = 3;

/**
 * Score a candidate anchor: higher = more unique / stable.
 * Penalize: short, all lowercase/common words, starts with punctuation,
 *           contains template variables.
 */
function scoreAnchor(s) {
  if (s.includes('${') || s.includes('{{')) return -1;    // template variable
  if (/^\s*[-*#>]/.test(s)) return 0;                     // markdown list/header
  let score = s.length;
  if (/[A-Z]/.test(s)) score += 10;                       // has capitals
  if (/\d/.test(s)) score += 5;                            // has digits
  if (s.includes('—') || s.includes(':')) score += 3;     // punctuation variety
  return score;
}

/**
 * Extract candidate anchor substrings from prompt body text.
 * Prefers complete sentences/phrases, avoids template vars.
 * Also extracts static segments from template-heavy lines by splitting on ${...}.
 */
function extractAnchors(body) {
  // Matches any ${...} interpolation (known vars or generic ALL_CAPS pattern)
  const anyVarPattern = /\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g;

  const candidates = [];

  const tryAdd = (text) => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_ANCHOR_LEN) return;
    const score = scoreAnchor(trimmed);
    if (score > 0) candidates.push({ text: trimmed.slice(0, MAX_ANCHOR_LEN), score });
  };

  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const hasVars = anyVarPattern.test(trimmed);
    anyVarPattern.lastIndex = 0; // reset after test

    if (!hasVars) {
      // No vars — try the full line, then slide a window over long lines
      if (trimmed.length <= MAX_ANCHOR_LEN) {
        tryAdd(trimmed);
      } else {
        for (let i = 0; i + MIN_ANCHOR_LEN <= trimmed.length; i += 20) {
          tryAdd(trimmed.slice(i, i + MAX_ANCHOR_LEN));
        }
      }
    } else {
      // Has vars — split on each ${...} and extract static segments
      const segments = trimmed.split(anyVarPattern);
      for (const seg of segments) {
        // Try the raw segment
        tryAdd(seg);
        // If still too short, combine adjacent segments around the var
        // by looking for multi-word runs
        if (seg.trim().length >= 20) {
          // Slide a window if the segment itself is long
          for (let i = 0; i + MIN_ANCHOR_LEN <= seg.length; i += 15) {
            tryAdd(seg.slice(i, i + MAX_ANCHOR_LEN));
          }
        }
      }
      // Also try the full line with vars replaced by a placeholder —
      // useful when the vars are at the edges (e.g. "Use ${X} to read more...")
      const stripped = trimmed.replace(anyVarPattern, '\x00').replace(/\x00+/g, ' ');
      if (stripped.trim().length >= MIN_ANCHOR_LEN) {
        // Don't add the stripped version as an anchor (won't match bundle),
        // but DO try sub-slices around static runs
        const runs = stripped.split('\x00').map(s => s.trim()).filter(s => s.length >= MIN_ANCHOR_LEN);
        for (const run of runs) tryAdd(run);
      }
    }
  }

  // Deduplicate by text content
  const seen = new Set();
  const unique = candidates.filter(c => {
    if (seen.has(c.text)) return false;
    seen.add(c.text);
    return true;
  });

  // Return top N by score
  return unique
    .sort((a, b) => b.score - a.score)
    .slice(0, ANCHORS_PER_PROMPT)
    .map(c => c.text);
}

// ─── Bundle search ────────────────────────────────────────────────────────────

/**
 * Search bundle text for an anchor string.
 * Returns { found, line, charOffset, occurrences } or { found: false }.
 * occurrences > 1 means the anchor is ambiguous (appears in multiple places).
 */
function findInBundle(bundle, anchor) {
  const idx = bundle.indexOf(anchor);
  if (idx === -1) return { found: false };

  // Count total occurrences to flag ambiguous anchors
  let occurrences = 0;
  let pos = 0;
  while ((pos = bundle.indexOf(anchor, pos)) !== -1) { occurrences++; pos++; }

  // Compute line number (1-based) for first occurrence
  const before = bundle.slice(0, idx);
  const line = (before.match(/\n/g) || []).length + 1;

  return { found: true, line, charOffset: idx, occurrences };
}

// ─── Hash comparison ──────────────────────────────────────────────────────────

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

function loadHashes() {
  if (!fs.existsSync(HASHES_PATH)) return {};
  return JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load bundle
  const bundlePath = detectBundle();
  if (!args.json) {
    process.stdout.write(`${c.bold}Bundle:${c.reset}  ${bundlePath}\n`);
    process.stdout.write(`${c.bold}Prompts:${c.reset} ${PROMPTS_DIR}\n\n`);
  }

  if (!fs.existsSync(PROMPTS_DIR)) {
    console.error(`${c.red}Error:${c.reset} prompts dir not found: ${PROMPTS_DIR}`);
    console.error(`Install tweakcc or pass --prompts <dir>`);
    process.exit(1);
  }

  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const knownHashes = loadHashes();

  // Enumerate prompt files
  let files = fs.readdirSync(PROMPTS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (args.filter) {
    const pat = new RegExp(args.filter.replace(/\*/g, '.*'));
    files = files.filter(f => pat.test(f));
  }

  const catalog = [];
  let found = 0, missing = 0, hashDrift = 0, ambiguous = 0;

  for (const file of files) {
    const filePath = path.join(PROMPTS_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const { name, description, ccVersion, body } = parsePromptFile(raw);

    const promptId = file.replace(/\.md$/, '');
    const anchors = extractAnchors(body);
    const bodyHash = md5(body);

    // Hash drift check: compare body hash vs tweakcc's known hashes
    // tweakcc keys are `${promptId}-${ccVersion}` or variations
    const hashKey = `${promptId}-${ccVersion}`;
    const knownHash = knownHashes[hashKey];
    const hashDrifted = knownHash && knownHash !== bodyHash;
    if (hashDrifted) hashDrift++;

    // Search for each anchor in the bundle
    const hits = anchors.map(anchor => findInBundle(bundle, anchor));
    const bestHit = hits.find(h => h.found);

    // For ambiguous anchors (occurrences > 1), try to find a unique one
    let resolvedHit = bestHit;
    let resolvedAnchorIdx = bestHit ? hits.indexOf(bestHit) : -1;
    if (bestHit && bestHit.occurrences > 1) {
      const uniqueIdx = hits.findIndex(h => h.found && h.occurrences === 1);
      if (uniqueIdx !== -1) {
        resolvedHit = hits[uniqueIdx];
        resolvedAnchorIdx = uniqueIdx;
      }
    }

    const entry = {
      id: promptId,
      file,
      name,
      description,
      ccVersion,
      variables,
      anchors: anchors.map((text, i) => ({ text, ...hits[i] })),
      found: !!resolvedHit,
      ambiguous: !!(resolvedHit && resolvedHit.occurrences > 1),
      line: resolvedHit?.line ?? null,
      charOffset: resolvedHit?.charOffset ?? null,
      occurrences: resolvedHit?.occurrences ?? null,
      bestAnchor: resolvedHit ? anchors[resolvedAnchorIdx] : null,
      bodyHash,
      knownHash: knownHash || null,
      hashDrifted,
    };

    catalog.push(entry);

    if (entry.found) found++;
    else missing++;
    if (entry.ambiguous) ambiguous++;
  }

  // Apply filters
  let display = catalog;
  if (args.changed) display = catalog.filter(e => e.hashDrifted);
  if (args.missing) display = catalog.filter(e => !e.found);

  // ── JSON output ──
  if (args.json) {
    console.log(JSON.stringify(display, null, 2));
  } else {
    // ── Table output ──
    const COL = { id: 40, line: 8, anchor: 65 };

    const header =
      `${c.bold}${'PROMPT ID'.padEnd(COL.id)} ${'LINE'.padStart(COL.line)}  ${'BEST ANCHOR'.padEnd(COL.anchor)}${c.reset}`;
    console.log(header);
    console.log('─'.repeat(COL.id + COL.line + COL.anchor + 4));

    for (const e of display) {
      const lineStr = e.found ? String(e.line).padStart(COL.line) : '    n/a ';
      const anchorPreview = e.bestAnchor
        ? e.bestAnchor.slice(0, COL.anchor - 1)
        : e.anchors[0]?.text?.slice(0, COL.anchor - 1) ?? '(no candidate found)';

      const rowColor = !e.found ? c.red
        : e.ambiguous ? c.cyan
        : e.hashDrifted ? c.yellow
        : c.green;

      const idStr = e.id.padEnd(COL.id);
      const marker = e.hashDrifted ? `${c.yellow}~${c.reset}`
        : e.ambiguous    ? `${c.cyan}?${c.reset}`
        : ' ';

      console.log(
        `${rowColor}${idStr}${c.reset}` +
        `${marker}` +
        `${c.dim}${lineStr}${c.reset}  ` +
        `${c.gray}${anchorPreview}${c.reset}` +
        (e.ambiguous ? ` ${c.cyan}(×${e.occurrences})${c.reset}` : '')
      );

      // Show all anchors for missing entries so user can debug
      if (!e.found && !args.json) {
        for (const a of e.anchors) {
          console.log(`  ${c.dim}candidate: "${a.text.slice(0, 80)}"${c.reset}`);
        }
      }
    }

    console.log();
    console.log(
      `${c.bold}Results:${c.reset} ` +
      `${c.green}${found} found${c.reset}  ` +
      `${c.red}${missing} missing${c.reset}  ` +
      (ambiguous ? `${c.cyan}${ambiguous} ambiguous${c.reset}  ` : '') +
      (hashDrift ? `${c.yellow}${hashDrift} hash-drifted${c.reset}  ` : '') +
      `${c.dim}(${display.length} shown of ${catalog.length} total)${c.reset}`
    );
  }

  // ── Write catalog JSON ──
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2));
  if (!args.json) {
    console.log(`\n${c.dim}Catalog written → ${OUT_PATH}${c.reset}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

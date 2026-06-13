#!/usr/bin/env node
/**
 * scripts/lint-capabilities.mjs — capability-honesty lint.
 *
 * THREAT_MODEL.md's capability gate is only as good as each patch's declared
 * `capabilities` array. This lint cross-checks every patch source in core/ and
 * extensions/ against syscall-shaped patterns and fails when a pattern implies
 * a capability the patch does not declare:
 *
 *   network — require/import of node:net / node:http(s) / node:tls / node:dgram,
 *             or a `fetch(` call (patch source AND injected code strings both
 *             count: code a patch splices into the bundle runs with the
 *             patch's declared powers).
 *   exec    — require/import of (node:)child_process, or spawn/spawnSync/
 *             execFile/execFileSync/execSync call shapes. Bare `exec(` is NOT
 *             matched (RegExp.prototype.exec is ubiquitous in patch code).
 *   fs      — node:fs WRITE shapes (writeFileSync/appendFileSync/
 *             createWriteStream/mkdirSync/rmSync/unlinkSync/renameSync/
 *             copyFileSync/chmodSync). Reads alone are not flagged.
 *   env     — process.env WRITES (assignment), e.g. `process.env.FOO = ...`.
 *             Reads alone are not flagged (the documented `env:` field covers
 *             those).
 *
 * This is a HEURISTIC: lines that are pure comments are skipped, and known
 * false positives are suppressed via the comment-documented ALLOWLIST below.
 * Files in IN_FLIGHT_FIXES are reported as WARN (not error) because their
 * capability declarations are being corrected in a parallel change — remove
 * entries from that set as the fixes land.
 *
 * Declared capabilities are read with runner/capability-reader.mjs (vm sandbox
 * with regex fallback) — the same reader the build gate uses.
 *
 * Exit 0 when no errors (warnings allowed); exit 1 on any error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPatchCapabilities } from '../runner/capability-reader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Allowlist (documented false positives) ───────────────────────────────────
// file (repo-relative, forward slashes) → { capability: 'reason' }.
// Every entry MUST say why the hit is a false positive (or carry a TODO when
// it is a real-but-deferred fix). Keyed by capability so an allowlisted file
// is still linted for the OTHER capabilities.
const ALLOWLIST = {
  // extensions/capture_interactive_request.mjs writes storage/logs/ (capture
  // sink for the first /v1/messages request shape) but declares only
  // ['network']. This is a REAL gap, not a false positive.
  // TODO(capability-honesty): add 'fs' to that patch's capabilities array and
  // delete this entry — allowlisted only because patch files are owned by the
  // corpus stream, not by this lint change.
  'extensions/capture_interactive_request.mjs': {
    fs: 'real fs write (storage/logs) — declaration fix pending, see TODO above',
  },
};

// ── In-flight fixes (warn, don't fail) ───────────────────────────────────────
// These four files' capability declarations are being corrected in a parallel
// change; their violations are surfaced as WARN so this lint can land first.
// TODO(capability-honesty): remove each entry as its declaration fix merges —
// at that point any remaining violation becomes a hard error.
const IN_FLIGHT_FIXES = new Set([
  'extensions/headless_bridge.mjs',
  'extensions/expose_tool_dispatch.mjs',
  'extensions/policy_gate.mjs',
  'extensions/auth_token.mjs',
]);

// ── Syscall-shaped patterns ──────────────────────────────────────────────────
// Each: { cap, label, re }. `re` is tested per-line (comment-only lines are
// skipped first).
const PATTERNS = [
  {
    cap: 'network',
    label: 'require/import of node:net|http|https|tls|dgram',
    re: /["'`]node:(?:net|http|https|tls|dgram)["'`]|["'`](?:net|http|https|tls|dgram)["'`]\s*\)/,
  },
  { cap: 'network', label: 'fetch(...) call', re: /\bfetch\s*\(/ },
  {
    cap: 'exec',
    label: 'require/import of child_process',
    re: /["'`](?:node:)?child_process["'`]/,
  },
  {
    cap: 'exec',
    label: 'spawn/execFile/execSync call shape',
    // (?<![.\w]) — exclude method calls like foo.spawn( and re.execSync? noise;
    // bare `exec(` is intentionally NOT matched (RegExp.prototype.exec).
    re: /(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/,
  },
  {
    cap: 'fs',
    label: 'node:fs write shape',
    re: /\b(?:writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|chmodSync)\s*\(/,
  },
  {
    cap: 'env',
    label: 'process.env write',
    re: /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=(?![=>])/,
  },
];

/** Recursively collect .mjs files under a dir (skips fixtures/, dotfiles). */
function collectMjs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'fixtures') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) collectMjs(abs, out);
    else if (ent.isFile() && ent.name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

/** True for lines that are pure comments (// …, * …, /* …). */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Scan one file: return [{ cap, label, line, excerpt }] for every
 * syscall-shaped hit whose capability is NOT declared.
 */
export function scanFile(absPath, declaredCaps) {
  const declared = new Set(declaredCaps);
  const src = fs.readFileSync(absPath, 'utf8');
  const lines = src.split('\n');
  const hits = [];
  const seen = new Set(); // one report per (cap,label) per file keeps output readable
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const { cap, label, re } of PATTERNS) {
      if (declared.has(cap)) continue;
      const key = `${cap}\x00${label}`;
      if (seen.has(key)) continue;
      if (re.test(line)) {
        seen.add(key);
        hits.push({ cap, label, line: i + 1, excerpt: line.trim().slice(0, 100) });
      }
    }
  }
  return hits;
}

function relPath(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/**
 * readPatchCapabilities logs an expected "[capability-reader] vm sandbox
 * failed … falling back to regex" warning for every ESM patch that uses
 * `import` (the vm path only handles `export default`). The regex fallback is
 * the designed path for those files, so the warning is pure noise here —
 * filter exactly that prefix and let everything else through.
 */
function readDeclaredCaps(abs) {
  const origWarn = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[capability-reader]')) return;
    origWarn(...args);
  };
  try {
    return readPatchCapabilities(abs);
  } finally {
    console.warn = origWarn;
  }
}

/** Run the lint over core/ + extensions/. Returns the process exit code. */
export function runLint() {
  const files = [
    ...collectMjs(path.join(ROOT, 'core')),
    ...collectMjs(path.join(ROOT, 'extensions')),
  ].sort();

  let errorCount = 0;
  let warnCount = 0;

  for (const abs of files) {
    const rel = relPath(abs);
    const declared = readDeclaredCaps(abs);
    const allow = ALLOWLIST[rel] || {};
    const hits = scanFile(abs, declared).filter(h => !(h.cap in allow));
    if (hits.length === 0) continue;
    const inFlight = IN_FLIGHT_FIXES.has(rel);
    for (const h of hits) {
      const msg = `${rel}:${h.line} uses ${h.label} but does not declare capability '${h.cap}' (declared: [${declared.join(', ')}])\n    ${h.excerpt}`;
      if (inFlight) {
        warnCount++;
        console.warn(`WARN: ${msg}\n    [in-flight fix — TODO(capability-honesty): becomes an error once the parallel declaration fix lands]`);
      } else {
        errorCount++;
        console.error(`ERROR: ${msg}`);
      }
    }
  }

  if (errorCount > 0) {
    console.error(`\nlint-capabilities: ${errorCount} error(s), ${warnCount} in-flight warning(s) across ${files.length} files.`);
    return 1;
  }
  console.log(`OK: capability declarations match syscall-shaped usage (${files.length} files scanned${warnCount ? `, ${warnCount} in-flight warning(s)` : ''}).`);
  return 0;
}

// Run as a gate only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runLint());
}

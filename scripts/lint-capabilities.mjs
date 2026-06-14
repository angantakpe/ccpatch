#!/usr/bin/env node
/**
 * scripts/lint-capabilities.mjs — capability-honesty lint.
 *
 * ┌─ READ THIS FIRST: WHAT THIS LINT IS, AND WHAT IT IS NOT ───────────────────┐
 * │ This is a BEST-EFFORT HEURISTIC TRIPWIRE, not a sandbox and not a          │
 * │ guarantee. It scans STATIC SOURCE TEXT for syscall-shaped patterns         │
 * │ (regexes — see PATTERNS below) and never executes the patch. It therefore  │
 * │ CANNOT see capability use that is:                                         │
 * │   • indirect — reached through a helper, re-exported binding, or aliased    │
 * │     reference the regex does not model (e.g. `const f = globalThis.fetch;   │
 * │     f(url)`, `const cp = require('node:' + 'child_process')`);             │
 * │   • dynamic — assembled at runtime from computed strings, `eval`,           │
 * │     `new Function`, property access by variable name, or imported from a    │
 * │     dependency that does the syscall on the patch's behalf;                 │
 * │   • injected-string — code a patch SPLICES INTO the bundle as a string     │
 * │     literal and that the live CLI later runs. The scanner reads that as     │
 * │     inert text; it does not run it, so a capability exercised only by the   │
 * │     injected code can slip past unless its source happens to contain a      │
 * │     matched pattern verbatim. (Several PATTERNS are deliberately written   │
 * │     to catch the COMMON injected-string shapes, but coverage is not total.) │
 * │                                                                            │
 * │ A CLEAN RUN MEANS exactly: "no obvious undeclared syscall-shaped patterns  │
 * │ were found in the static source." It does NOT mean "this patch is          │
 * │ incapable of network / fs / exec / env access." A patch can declare        │
 * │ `capabilities: []` and still touch the network (or disk, or a subprocess)  │
 * │ through any of the paths above and pass this lint clean.                   │
 * │                                                                            │
 * │ The REAL trust backstop is NOT this script. It is:                         │
 * │   • the `ack:` capability gate in ccpatch.yml (build-time, refuses to       │
 * │     apply gate-required capabilities until acknowledged);                  │
 * │   • human review of the patch source before enabling it;                   │
 * │   • the in-process, UNSANDBOXED trust model — an enabled patch runs with   │
 * │     the full privileges of the CLI itself (see THREAT_MODEL.md / SECURITY  │
 * │     .md). There is no runtime isolation between a patch and the CLI.       │
 * │                                                                            │
 * │ Treat this lint as a cheap early-warning signal that catches the careless  │
 * │ and honest-mistake cases, NOT as evidence that a patch's declared          │
 * │ capabilities are exhaustive. See the "Capability honesty: heuristic, not  │
 * │ a guarantee" subsection of THREAT_MODEL.md.                                │
 * └────────────────────────────────────────────────────────────────────────────┘
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
  // (empty) — every entry here must document why a syscall-shaped hit is a FALSE
  // positive. The one prior entry (capture_interactive_request's fs write) was a
  // REAL gap, not a false positive, and is now declared honestly in the patch's
  // capabilities array, so the allowlist no longer suppresses any real capability.
  // Keep this map empty unless you can name a genuine false positive: a lint hit
  // on code that does NOT actually exercise the capability (e.g. the literal
  // appears only in a string the patch never runs).
};

// ── In-flight fixes (warn, don't fail) ───────────────────────────────────────
// (empty) — this set downgrades a file's capability violations from ERROR to
// WARN while its declaration is being corrected in a parallel change. All four
// former entries (headless_bridge, expose_tool_dispatch, policy_gate, auth_token)
// now declare their full honest capability set, so the lint passes them clean
// with no suppression. The gate is once again strict: any undeclared
// syscall-shaped pattern is a hard error, not a warning. Re-add a file here ONLY
// as a short-lived bridge while a real declaration fix is mid-flight, and delete
// it the moment that fix lands.
const IN_FLIGHT_FIXES = new Set([]);

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
  console.log(`OK: no undeclared syscall-shaped patterns found in ${files.length} scanned files${warnCount ? ` (${warnCount} in-flight warning(s))` : ''}.`);
  // Honesty caveat (mirrors the header block + THREAT_MODEL.md): a clean run is a
  // heuristic tripwire, NOT proof a patch is incapable of network/fs/exec/env.
  // Indirect, dynamic, and injected-string capability use slips past this scan.
  // The real backstop is the ack gate + human review of the unsandboxed source.
  console.log('     (heuristic only — does NOT prove capability-incapability; see THREAT_MODEL.md)');
  return 0;
}

// Run as a gate only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runLint());
}

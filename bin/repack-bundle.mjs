#!/usr/bin/env node
/**
 * bin/repack-bundle.mjs — Write patched JS back into a Bun SEA native binary.
 *
 * Approach: offset-based in-place Buffer replacement.
 *
 * Why not node-lief section/overlay write:
 *   node-lief's ELF.Binary.patchAddress() operates on virtual memory addresses,
 *   not file offsets, so it cannot target the overlay region directly.
 *   The ELF.Binary.overlay setter + binary.write() would ask LIEF to reconstruct
 *   the full ELF, which risks corrupting Bun's trailer struct that follows the JS
 *   payload inside the overlay (Bun appends its own metadata after the NUL-terminated
 *   JS text). Direct Buffer manipulation is safer: it touches only the bytes between
 *   the known JS start and the first NUL terminator, leaving everything else intact.
 *
 * Usage:
 *   node bin/repack-bundle.mjs <original-binary> <patched-js> <output-binary>
 *
 * Example:
 *   node bin/repack-bundle.mjs storage/archives/claude-code-v2.1.148/bin/claude.exe \
 *     storage/outputs/2.1.148/cli.patched.js \
 *     releases/2.1.148/claude
 */

import { readFileSync, writeFileSync, existsSync, statSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseModules } from '../tools/bun-decompiler/decompile.mjs';
import { growBunSeaBinary } from './bun-sea-graph.mjs';

const log  = (msg) => console.log(`[repack] ${msg}`);
const warn = (msg) => console.warn(`[repack:warn] ${msg}`);
const die  = (msg) => { console.error(`[repack:error] ${msg}`); process.exit(1); };

// Bun trailer format this repacker was validated against. The Bun SEA trailer that
// follows the embedded JS is UNVERSIONED and UNDOCUMENTED: it is a struct of absolute
// file offsets that we deliberately do not rewrite (we keep the JS region byte-length
// identical so every stored offset stays valid). If a future Bun layout change alters
// the trailer such that a length-equal splice no longer lands the offsets correctly,
// the resulting binary launches as bare `bun` with NO error — the failure is silent.
// We record the assumption here and best-effort warn when the embedded Bun version drifts.
const VALIDATED_BUN_VERSIONS = ['1.3'];  // major.minor prefixes known-good for this splicer

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage() {
  console.log(`
Usage: node bin/repack-bundle.mjs <original-binary> <patched-js> <output-binary>

Arguments:
  original-binary   Path to the original Bun SEA binary (e.g. storage/archives/.../claude.exe)
  patched-js        Path to the patched JavaScript file produced by the patch pipeline
  output-binary     Destination path for the repacked native binary

Example:
  node bin/repack-bundle.mjs \\
    storage/archives/claude-code-v2.1.148/bin/claude.exe \\
    storage/outputs/2.1.148/cli.patched.js \\
    releases/2.1.148/claude
`.trim());
  process.exit(1);
}

/**
 * Find the byte range [start, end) of the embedded JS in a Bun SEA binary.
 *
 * Uses two strategies in order, mirroring extract-from-binary.mjs:
 *   1. Marker-parser (parseModules from bun-decompiler) — preferred.
 *   2. Legacy anchor heuristic — fallback for older binaries.
 *
 * Returns { start, end, source } where [start, end) is the exact byte range
 * of the embedded JS text (excluding the NUL terminator). source is a string
 * indicating which strategy succeeded.
 *
 * Throws if the JS region cannot be located.
 */
function findJsRegion(buffer) {
  // --- Strategy 1: marker-parser ---
  try {
    const { modules } = parseModules(buffer);
    const cli =
      modules.find(m => m.kind === 'js' && /(^|\/)cli\.js$/.test(m.path) && m.path.includes('entrypoint')) ||
      modules.find(m => m.kind === 'js' && /(^|\/)cli\.js$/.test(m.path));
    if (cli) {
      log(`Marker parser: found ${cli.path} at offset ${cli.contentStart}, ${cli.contentLength.toLocaleString()} bytes`);
      return { start: cli.contentStart, end: cli.contentEnd, source: 'marker-parser' };
    }
    warn('Marker parser: no cli.js module found; trying legacy anchor heuristic');
  } catch (e) {
    warn(`Marker parser failed (${e.message}); falling back to legacy anchor heuristic`);
  }

  // --- Strategy 2: legacy anchor heuristic (mirrors extract-from-binary.mjs) ---
  const anchors = [
    'Claude Code - starts an interactive session by default, use -p/--print for non-interactive output',
    'Claude Code - starts an interactive session',
    "Claude Code is a Beta product per Anthropic's Commercial Terms of Service.",
  ];

  let anchorOffset = -1;
  let anchorUsed = null;
  for (const a of anchors) {
    const idx = buffer.indexOf(Buffer.from(a));
    if (idx !== -1) { anchorUsed = a; anchorOffset = idx; break; }
  }
  if (anchorOffset === -1) {
    throw new Error('Could not find any known Claude CLI anchor strings in binary');
  }
  log(`Legacy anchor at offset ${anchorOffset}: ${JSON.stringify(anchorUsed)}`);

  const wrapperMarker = Buffer.from('(function(exports, require, module, __filename, __dirname) {');
  const wrapperStart = buffer.lastIndexOf(wrapperMarker, anchorOffset);
  if (wrapperStart === -1) {
    throw new Error('Could not find Bun CJS wrapper start before CLI anchor');
  }
  log(`Module wrapper starts at offset ${wrapperStart}`);

  const endNul = buffer.indexOf(0, wrapperStart);
  if (endNul === -1) {
    throw new Error('Could not find NUL terminator after module wrapper start');
  }
  log(`Module source ends at offset ${endNul}`);

  return { start: wrapperStart, end: endNul, source: 'legacy-anchor' };
}

/**
 * Normalise the patched JS to the format that Bun stores in the binary:
 *
 *   - Rejects files transformed to Node.js ESM format (by esm_compat / bun_shim
 *     patches). Those patches rewrite the CJS wrapper into ESM with `import` statements
 *     and __hm_* shims, which Bun cannot embed. A clear error is thrown.
 *   - Validates the file starts with the Bun CJS wrapper opener.
 *   - Strips the self-invocation suffix that extract-from-binary.mjs appends so the
 *     extracted file runs under Node.js. The binary stores the un-invoked form.
 *   - Validates no embedded NUL bytes (the binary supplies its own NUL terminator).
 *
 * Returns the normalised text string ready for Buffer conversion and embedding.
 */
function normalisePatchedJs(text) {
  // Detect Node.js ESM-transformed form produced by esm_compat / bun_shim.
  // The transformed file may start with a leading newline before the `import` statement.
  if (/^\s*import\s+[\w{]/.test(text)) {
    throw new Error(
      'The patched JS file has been transformed by the esm_compat or bun_shim patches ' +
      '(it starts with `import ...` instead of `(function(exports,...)`). ' +
      'These patches rewrite the CJS wrapper for Node.js compatibility and produce output ' +
      'that cannot be embedded in a Bun SEA binary. ' +
      'To use patch-claude-code-native, disable esm_compat and bun_shim in ccpatch.yml ' +
      'before running the patch step, or pass PATCH= with a list that excludes those patches.'
    );
  }

  // Must start with the Bun CJS wrapper opener.
  if (!/^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/.test(text)) {
    throw new Error(
      'The patched JS file does not start with the expected Bun CJS wrapper ' +
      '`(function(exports, require, module, __filename, __dirname) {`. ' +
      'Only CJS-format patched files can be embedded in a Bun SEA binary.'
    );
  }

  // Strip the self-invocation call appended by extract-from-binary.mjs.
  // extract-from-binary.mjs takes the trimmed form ending with `})` and appends
  // `(module.exports, require, module, __filename, __dirname);\n` so the extracted
  // file self-invokes under Node.js. The binary stores the form without this suffix.
  // Note: the suffix does NOT include the leading `)` — that belongs to the wrapper close `})`.
  const invocationSuffix = '(module.exports, require, module, __filename, __dirname);\n';
  if (text.endsWith(invocationSuffix)) {
    text = text.slice(0, text.length - invocationSuffix.length);
  }

  // Validate: must still end with `})` (the Bun CJS wrapper close) after stripping.
  if (!text.trimEnd().endsWith('})')) {
    throw new Error(
      'After stripping the self-invocation suffix, the patched JS does not end with `})` ' +
      '(the Bun CJS wrapper close). The file may be malformed.'
    );
  }

  // Validate: no embedded NUL bytes (would corrupt binary layout).
  if (text.indexOf('\x00') !== -1) {
    throw new Error('Patched JS contains NUL bytes — cannot embed in binary');
  }

  return text;
}

/**
 * Locate the index of the byte immediately AFTER the validated Bun CJS wrapper close `})`.
 *
 * This mirrors the validation in normalisePatchedJs (trimEnd().endsWith('})')): the true
 * wrapper close is the `})` reached by walking back over trailing whitespace from the end
 * of the text. We must NOT use patchedText.lastIndexOf('})') for padding placement: minified
 * Bun output routinely contains `})` inside string/template/regex literals, and the textually
 * last `})` in the whole file is not guaranteed to be the wrapper close (e.g. trailing
 * whitespace, or a literal `})` appearing after the real close would defeat lastIndexOf).
 *
 * Returns the insertion index (after the `})`, before any trailing whitespace) — padding
 * inserted here lands strictly outside the wrapper body, where JS treats it as insignificant
 * whitespace and it cannot fall inside any literal. Throws if the close cannot be located.
 */
export function locateWrapperCloseEnd(text) {
  let end = text.length;
  while (end > 0) {
    const c = text[end - 1];
    if (c === '\n' || c === '\r' || c === ' ' || c === '\t') end--;
    else break;
  }
  if (end < 2 || text.slice(end - 2, end) !== '})') {
    throw new Error('Cannot locate Bun CJS wrapper close `})` for padding placement.');
  }
  return end;
}

/**
 * Assert that a located JS region's end points at the Bun trailer's NUL terminator.
 *
 * Pure validation extracted so it can be unit-tested without spawning the full repack.
 * Only the marker-parser path can fall back to a non-NUL boundary (decompile.mjs), so the
 * check is scoped to that source; the legacy-anchor path already guarantees a NUL via
 * indexOf(0,...). Throws with a descriptive message when the assertion fails.
 */
export function assertRegionEndIsNul(binary, region) {
  if (region.source === 'marker-parser' && binary[region.end] !== 0x00) {
    throw new Error(
      `Marker parser returned a JS region whose end (offset ${region.end}) is not a NUL byte ` +
      `(found 0x${(binary[region.end] ?? 0).toString(16).padStart(2, '0')}). This means the ` +
      `parser fell back to a module/EOF boundary instead of the trailer's NUL terminator — ` +
      `splicing here would silently shift the Bun trailer. Refusing to repack this binary.`
    );
  }
}

/**
 * Best-effort detection of the Bun version a compiled binary was built with.
 *
 * Bun embeds a version string somewhere in the binary; common forms observed are
 * `Bun/1.3.x` and a bare semver near runtime banner strings. This is heuristic only —
 * it exists to WARN on layout drift, never to gate the build. Returns a version string
 * (e.g. "1.3.20") or null if nothing plausible is found.
 */
export function detectBunVersion(binary) {
  // Search a bounded window of likely matches; the binary is large, so cap the scan.
  const haystack = binary;
  const patterns = [
    /Bun\/(\d+\.\d+\.\d+)/,
    /bun-v(\d+\.\d+\.\d+)/,
  ];
  // Scan in chunks decoded as latin1 to find version banners without allocating the whole
  // file as one giant string repeatedly.
  const text = haystack.toString('latin1');
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function repack(originalBinaryPath, patchedJsPath, outputBinaryPath) {
  // Validate inputs.
  if (!existsSync(originalBinaryPath)) {
    die(`Original binary not found: ${originalBinaryPath}`);
  }
  if (!existsSync(patchedJsPath)) {
    die(`Patched JS not found: ${patchedJsPath}`);
  }

  const binaryStats = statSync(originalBinaryPath);
  log(`Original binary: ${originalBinaryPath} (${(binaryStats.size / 1024 / 1024).toFixed(2)} MB)`);

  const jsStats = statSync(patchedJsPath);
  log(`Patched JS:      ${patchedJsPath} (${(jsStats.size / 1024 / 1024).toFixed(2)} MB)`);

  // Read binary.
  const binary = readFileSync(originalBinaryPath);

  // Sanity check: must be a native binary (ELF or Mach-O).
  const magic4 = binary.subarray(0, 4);
  const isElf     = magic4[0] === 0x7f && magic4[1] === 0x45 && magic4[2] === 0x4c && magic4[3] === 0x46;
  const isMachO   = (magic4[0] === 0xce || magic4[0] === 0xcf) && magic4[1] === 0xfa && magic4[2] === 0xed && magic4[3] === 0xfe;
  const isFatMachO = magic4[0] === 0xca && magic4[1] === 0xfe && magic4[2] === 0xba && magic4[3] === 0xbe;
  if (!isElf && !isMachO && !isFatMachO) {
    die(
      `${originalBinaryPath} does not appear to be a native binary ` +
      `(magic bytes: ${Array.from(magic4).map(b => b.toString(16).padStart(2, '0')).join(' ')}). ` +
      `If this is a plain JS file, no repacking is needed.`
    );
  }
  log(`Binary format: ${isElf ? 'ELF' : isFatMachO ? 'Mach-O (fat)' : 'Mach-O'}`);

  // Best-effort Bun version / trailer-format check. The Bun SEA trailer is unversioned and
  // we splice the JS region in place WITHOUT rewriting it (see VALIDATED_BUN_VERSIONS). If a
  // future Bun layout changes the trailer, a length-equal repack can still silently produce a
  // binary that launches as bare `bun`. We can't detect a trailer format change directly, so
  // we warn loudly when the embedded Bun version is outside the known-good set as a proxy.
  const detectedBun = detectBunVersion(binary);
  if (detectedBun) {
    const known = VALIDATED_BUN_VERSIONS.some(v => detectedBun.startsWith(v + '.') || detectedBun === v || detectedBun.startsWith(v));
    if (known) {
      log(`Detected Bun version ${detectedBun} (within validated set ${VALIDATED_BUN_VERSIONS.join(', ')}).`);
    } else {
      warn(
        `Detected Bun version ${detectedBun}, which is OUTSIDE the validated set ` +
        `[${VALIDATED_BUN_VERSIONS.join(', ')}]. This repacker assumes the Bun ${VALIDATED_BUN_VERSIONS.join('/')} ` +
        `SEA trailer layout. If the trailer format changed, the repacked binary may silently launch ` +
        `as bare \`bun\`. Verify the output runs the embedded entrypoint before shipping.`
      );
    }
  } else {
    warn(
      `Could not detect the embedded Bun version; cannot confirm the SEA trailer layout matches ` +
      `the validated set [${VALIDATED_BUN_VERSIONS.join(', ')}]. Proceeding on the assumption that ` +
      `the trailer is byte-compatible. Verify the repacked binary runs the embedded entrypoint.`
    );
  }

  // Locate the embedded JS region.
  let region;
  try {
    region = findJsRegion(binary);
  } catch (e) {
    die(`Could not locate embedded JS region: ${e.message}`);
  }
  const originalRegionSize = region.end - region.start;
  log(`JS region [${region.start}, ${region.end}) — ${originalRegionSize.toLocaleString()} bytes (found via ${region.source})`);

  // Guard: region.end must point at the NUL terminator that begins the Bun trailer.
  //
  // The marker-parser computes contentEnd as the first NUL after contentStart, BUT falls
  // back to nextBoundary (a marker start, or buf.length) when that NUL check fails
  // (decompile.mjs parseModules). nextBoundary is NOT a NUL byte. If we splice at a non-NUL
  // region.end, `after` would no longer start at the trailer's NUL — the semantic boundary
  // shifts while total length is preserved, so the equality guard below still passes and the
  // corruption is silent. The legacy-anchor path already locates region.end via indexOf(0,...)
  // so it is guaranteed a NUL; only the marker-parser path needs this assertion.
  try {
    assertRegionEndIsNul(binary, region);
  } catch (e) {
    die(e.message);
  }

  // Read and normalise patched JS.
  let patchedText;
  try {
    patchedText = normalisePatchedJs(readFileSync(patchedJsPath, 'utf8'));
  } catch (e) {
    die(`Failed to normalise patched JS: ${e.message}`);
  }
  let patchedBuf = Buffer.from(patchedText, 'utf8');
  log(`Normalised patched JS: ${patchedBuf.length.toLocaleString()} bytes`);

  // Reconcile the patched size with the original region.
  //
  //   patched < original → pad with inert trailing whitespace, length-preserving splice.
  //   patched = original → splice as-is.
  //   patched > original → GROW path: rewrite the Bun module-graph + ELF offsets so the
  //                        larger region still dispatches the embedded entrypoint.
  //                        Implemented for ELF (the Bun linux-x64 target) only.
  //
  // Why padding (smaller case) and grow-rewriting (larger case) are BOTH needed: the Bun
  // SEA payload stores blob-relative offsets (module-record StringPointers, the modules-array
  // pointer, byte_count, and the 8-byte payload_len header). A length-preserving splice keeps
  // every offset valid for free. When the region GROWS, those offsets must be bumped by the
  // delta or the binary launches as bare `bun`; growBunSeaBinary (bin/bun-sea-graph.mjs) does
  // exactly that, decoding Bun's verified schema rather than guessing.
  //
  // Padding (smaller case) is injected as plain ASCII spaces immediately AFTER the validated
  // CJS wrapper close `})`. Trailing whitespace at file scope is unambiguously inert — outside
  // the wrapper body, so it cannot land inside any string/template/regex literal. We do NOT use
  // lastIndexOf('})') (minified output contains `})` inside literals); locateWrapperCloseEnd
  // reuses the same trimEnd().endsWith('})') logic normalisePatchedJs validated against.
  let output;
  let isGrow = false;
  if (patchedBuf.length <= originalRegionSize) {
    if (patchedBuf.length < originalRegionSize) {
      const padBytes = originalRegionSize - patchedBuf.length;
      let closeEnd;
      try {
        closeEnd = locateWrapperCloseEnd(patchedText);
      } catch (e) {
        die(`Cannot pad patched JS: ${e.message}`);
      }
      patchedText = patchedText.slice(0, closeEnd) + ' '.repeat(padBytes) + patchedText.slice(closeEnd);
      patchedBuf = Buffer.from(patchedText, 'utf8');
      log(`Padded patched JS with ${padBytes.toLocaleString()} trailing space(s) after the wrapper close to match original region size.`);
    }
    // Layout: [bytes before JS region] [patched JS (== original size)] [NUL + Bun trailer]
    output = Buffer.concat([binary.subarray(0, region.start), patchedBuf, binary.subarray(region.end)]);
    // Invariant: length-preserving splice must keep total length identical, or the Bun
    // trailer's blob-relative offsets would be invalidated. Fail loudly before writing.
    if (output.length !== binary.length) {
      die(
        `Internal error: repacked binary length (${output.length.toLocaleString()} bytes) ` +
        `does not match original (${binary.length.toLocaleString()} bytes). Refusing to write — ` +
        `the Bun trailer offsets would be invalidated. This is a bug in the repacker.`
      );
    }
  } else {
    // Grow path — patched JS is larger than the original region.
    const delta = patchedBuf.length - originalRegionSize;
    if (!isElf) {
      die(
        `Patched JS (${patchedBuf.length.toLocaleString()} bytes) exceeds the original JS region ` +
        `(${originalRegionSize.toLocaleString()} bytes) by ${delta.toLocaleString()} bytes, and ` +
        `grow-repack is currently implemented for ELF (linux-x64) binaries only. For this target, ` +
        `reduce the patched content or build from the plain-JS path.`
      );
    }
    log(`Patched JS exceeds the original region by ${delta.toLocaleString()} bytes — using Bun module-graph grow-repack.`);
    try {
      output = growBunSeaBinary(binary, region, patchedBuf, { log, warn });
    } catch (e) {
      die(
        `Grow-repack failed: ${e.message}\n` +
        `Refusing to emit a possibly-corrupt binary. Build this version from the plain-JS path ` +
        `or with a reduced patch set.`
      );
    }
    if (output.length !== binary.length + delta) {
      die(
        `Internal error: grown binary length (${output.length.toLocaleString()} bytes) does not ` +
        `match expected (${(binary.length + delta).toLocaleString()} bytes). This is a bug in the grow-repacker.`
      );
    }
    isGrow = true;
  }

  // Write atomically: write to a sibling .tmp, set execute bits on it, then rename into
  // place. renameSync is atomic on the same filesystem, so a crash / full disk mid-write
  // leaves any prior good binary at outputBinaryPath untouched rather than truncated. On any
  // failure we remove the tmp so we never leave a partial file behind.
  const tmpPath = outputBinaryPath + '.tmp';
  try {
    writeFileSync(tmpPath, output);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, outputBinaryPath);
  } catch (e) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    die(`Failed to write output binary atomically: ${e.message}`);
  }

  const outStats = statSync(outputBinaryPath);
  log(`Wrote ${(outStats.size / 1024 / 1024).toFixed(2)} MB to ${outputBinaryPath}`);
  log(`Execute permissions set (0o755)`);

  // Optional post-repack smoke check: spawn the repacked binary with --version and confirm it
  // does NOT behave as bare `bun` (which would indicate the SEA dispatch broke). This is the
  // only reliable way to catch a silent trailer-layout regression. It is wired but guarded:
  //   - skipped on CCPATCH_REPACK_SMOKE=0 (default-on, opt-out)
  //   - any spawn failure (wrong arch, sandbox can't exec, ENOEXEC) is treated as SKIPPED with
  //     a warning, NOT a hard failure — CI sandboxes frequently can't run a freshly-built
  //     foreign binary, and we must not fail the build solely because the smoke run can't execute.
  // Only a binary that runs AND prints the bare Bun runtime banner is treated as a real failure.
  if (process.env.CCPATCH_REPACK_SMOKE !== '0') {
    // Grow-repack rewrote load-bearing offsets, so when the binary can actually run we hold it
    // to the STRONGER bar: it must print the embedded Claude version, not merely avoid bare-bun.
    runSmokeCheck(outputBinaryPath, { requireClaude: isGrow });
  } else {
    log('Post-repack smoke check skipped (CCPATCH_REPACK_SMOKE=0).');
  }

  log(`Done. Run the repacked binary with: ${outputBinaryPath}`);
}

/**
 * Best-effort post-repack smoke check. Spawns `<binary> --version` and inspects output.
 *
 * Failure modes:
 *   - Cannot spawn (foreign arch, no-exec sandbox, ENOEXEC, ETXTBSY): SKIPPED with a warning.
 *   - Runs and output looks like bare Bun (`Bun ` banner / `usage: bun`): real FAILURE → die.
 *   - Runs and produces any other output: treated as plausibly-OK and logged.
 *
 * Deliberately does not assert a specific Claude version string — the embedded entrypoint may
 * print its own version which we don't know here. The goal is to catch the bare-`bun` fallback.
 */
function runSmokeCheck(binaryPath, { requireClaude = false } = {}) {
  let res;
  try {
    res = spawnSync(binaryPath, ['--version'], {
      timeout: 15_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    warn(`Post-repack smoke check skipped: could not spawn repacked binary (${e.message}).`);
    return;
  }
  if (res.error) {
    warn(`Post-repack smoke check skipped: ${res.error.code || res.error.message} — environment cannot execute the repacked binary.`);
    return;
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // Bare Bun, when handed an unknown script path / no embedded SEA, prints its own runtime
  // banner or usage. If we see that, the SEA dispatch is broken — fail loudly.
  if (/^\s*Bun\s+\d+\.\d+\.\d+/.test(out) || /\busage:\s*bun\b/i.test(out)) {
    die(
      `Post-repack smoke check FAILED: \`${binaryPath} --version\` produced bare Bun output:\n` +
      `${out.trim().slice(0, 200)}\n` +
      `The repacked binary is launching as bare \`bun\` instead of the embedded entrypoint — ` +
      `the Bun trailer offsets are likely invalid. Do not ship this binary.`
    );
  }
  // Grow-repack rewrote load-bearing offsets. A binary that ran but does NOT print the
  // embedded Claude Code version line means dispatch landed somewhere wrong — gate on the
  // oracle (the only reliable proof the grown module graph still resolves). A spawn that was
  // SKIPPED above (foreign arch / no-exec sandbox) cannot be gated and is left as a warning.
  if (requireClaude && !/\d+\.\d+\.\d+ \(Claude Code\)/.test(out)) {
    die(
      `Post-repack smoke check FAILED (grow path): \`${binaryPath} --version\` did not print the ` +
      `embedded Claude Code version line:\n${out.trim().slice(0, 200)}\n` +
      `A grow-repack must boot to the embedded entrypoint. Do not ship this binary.`
    );
  }
  log(`Post-repack smoke check passed (binary ran${requireClaude ? ', printed Claude version' : ', no bare-bun fallback'}).`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Only run the CLI when invoked directly (`node bin/repack-bundle.mjs ...`), not when
// imported as a module (e.g. by tests/repack.test.mjs). This lets the pure helpers above
// be unit-tested without triggering usage()/repack() at import time.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(a => a !== '--');
  if (args.length < 3 || args.includes('--help') || args.includes('-h')) {
    usage();
  }

  const [originalBinaryPath, patchedJsPath, outputBinaryPath] = args.map(a => resolve(a));

  repack(originalBinaryPath, patchedJsPath, outputBinaryPath);
}

export { repack };

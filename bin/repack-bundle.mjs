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

import { readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModules } from '../tools/bun-decompiler/decompile.mjs';

const log  = (msg) => console.log(`[repack] ${msg}`);
const warn = (msg) => console.warn(`[repack:warn] ${msg}`);
const die  = (msg) => { console.error(`[repack:error] ${msg}`); process.exit(1); };

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

  // Locate the embedded JS region.
  let region;
  try {
    region = findJsRegion(binary);
  } catch (e) {
    die(`Could not locate embedded JS region: ${e.message}`);
  }
  const originalRegionSize = region.end - region.start;
  log(`JS region [${region.start}, ${region.end}) — ${originalRegionSize.toLocaleString()} bytes (found via ${region.source})`);

  // Read and normalise patched JS.
  let patchedText;
  try {
    patchedText = normalisePatchedJs(readFileSync(patchedJsPath, 'utf8'));
  } catch (e) {
    die(`Failed to normalise patched JS: ${e.message}`);
  }
  let patchedBuf = Buffer.from(patchedText, 'utf8');
  log(`Normalised patched JS: ${patchedBuf.length.toLocaleString()} bytes`);

  // Pad patched JS to match the original region size exactly.
  //
  // Empirically (Bun 1.3.x), shifting the trailer that follows the JS region causes the
  // SEA dispatch to fail — the binary launches as bare `bun` instead of running the
  // embedded entrypoint. The Bun trailer contains absolute file offsets that are not
  // updated by this script. Keeping the JS region the same size leaves every post-region
  // byte at its original file offset, so all stored offsets remain valid.
  //
  // Padding is injected as plain ASCII spaces immediately before the closing `})` of the
  // CJS wrapper. JavaScript treats them as insignificant whitespace; Bun's parser accepts
  // them. The original region size is the JS bytes only (excluding the NUL terminator
  // that `after` begins with), so we pad to that exact byte count.
  if (patchedBuf.length < originalRegionSize) {
    const padBytes = originalRegionSize - patchedBuf.length;
    const closeIdx = patchedText.lastIndexOf('})');
    if (closeIdx < 0) {
      die('Cannot pad patched JS: closing `})` of CJS wrapper not found.');
    }
    patchedText = patchedText.slice(0, closeIdx) + ' '.repeat(padBytes) + patchedText.slice(closeIdx);
    patchedBuf = Buffer.from(patchedText, 'utf8');
    log(`Padded patched JS with ${padBytes.toLocaleString()} space(s) to match original region size.`);
  } else if (patchedBuf.length > originalRegionSize) {
    die(
      `Patched JS (${patchedBuf.length.toLocaleString()} bytes) exceeds original JS region ` +
      `(${originalRegionSize.toLocaleString()} bytes). Growth is not supported by this repacker ` +
      `because the Bun trailer contains absolute file offsets that would need to be rewritten. ` +
      `Reduce the patched content or implement trailer-offset patching.`
    );
  }

  // Build output buffer. With padding above, total length matches the original exactly,
  // so the Bun trailer (in `after`, starting at the NUL byte) keeps its original file offsets.
  // Layout: [bytes before JS region] [patched JS (padded to original size)] [NUL + Bun trailer]
  const before = binary.subarray(0, region.start);
  const after  = binary.subarray(region.end);   // starts at the NUL byte
  const output = Buffer.concat([before, patchedBuf, after]);

  const delta = output.length - binary.length;
  if (delta !== 0) {
    log(`Binary size: ${delta > 0 ? '+' : ''}${delta.toLocaleString()} bytes → ${(output.length / 1024 / 1024).toFixed(2)} MB`);
  }

  // Write output binary with execute permissions.
  writeFileSync(outputBinaryPath, output);
  chmodSync(outputBinaryPath, 0o755);

  const outStats = statSync(outputBinaryPath);
  log(`Wrote ${(outStats.size / 1024 / 1024).toFixed(2)} MB to ${outputBinaryPath}`);
  log(`Execute permissions set (0o755)`);
  log(`Done. Run the repacked binary with: ${outputBinaryPath}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2).filter(a => a !== '--');
if (args.length < 3 || args.includes('--help') || args.includes('-h')) {
  usage();
}

const [originalBinaryPath, patchedJsPath, outputBinaryPath] = args.map(a => resolve(a));

repack(originalBinaryPath, patchedJsPath, outputBinaryPath);

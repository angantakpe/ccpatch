#!/usr/bin/env node
/**
 * src/cli/bin/extract-from-binary.mjs - Extract JavaScript from Bun-compiled binaries
 *
 * Usage:
 *   node src/cli/bin/extract-from-binary.mjs <binary> [output.js]
 *   node src/cli/bin/extract-from-binary.mjs storage/archives/claude-code-v2.1.114/bin/claude.exe cli.js
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseModules, getModuleSlice } from '../tools/bun-decompiler/decompile.mjs';

const log = (msg) => console.log(`[extract] ${msg}`);
const warn = (msg) => console.warn(`[warn] ${msg}`);
const error = (msg) => { console.error(`[error] ${msg}`); process.exit(1); };

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function usage() {
  console.log(`
Usage: node src/cli/bin/extract-from-binary.mjs <binary-path> [output-path]

Arguments:
  binary-path   Path to Bun-compiled binary (e.g., downloads/current/claude)
  output-path   Output JavaScript file (default: cli.js)

Example:
  node src/cli/bin/extract-from-binary.mjs downloads/current/claude cli.js
`.trim());
  process.exit(1);
}

/**
 * Heuristic: detect "plain JS" files by checking the first 4 KB for a NUL byte
 * (Bun-compiled binaries have NULs in their ELF header region; plain JS source
 * does not). False positives are possible if a JS file happens to contain a raw
 * NUL in its opening bytes, but that is extremely rare in practice.
 */
function looksLikePlainJS(buffer) {
  const header = buffer.slice(0, 4096).toString('utf8');
  const looksTexty =
    header.startsWith('#!') ||
    header.startsWith('var ') ||
    header.startsWith('"use strict"') ||
    header.startsWith('(function(');

  if (!looksTexty) return false;

  // Fix 3: bound the NUL scan to first 4096 bytes — avoids scanning the entire binary.
  const firstNul = buffer.slice(0, 4096).indexOf(0);
  if (firstNul !== -1) return false;
  return true;
}

/**
 * Extract the CLI's embedded source via the Bun module-marker parser.
 *
 * Walks the binary's `/$bunfs/root/<path>\0...` headers (see src/cli/decompilers/bun/decompile.mjs),
 * locates the cli.js module, strips trailing NUL padding, and keeps the CJS wrapper intact so
 * the output matches the legacy anchor-based extractor's format byte-for-byte.
 */
function extractViaMarkerParser(buffer) {
  const { modules, markerCount, rawCount } = parseModules(buffer);
  log(`Markers: ${markerCount} /$bunfs/root/ occurrences, ${rawCount} valid headers`);

  const cli = modules.find(m => m.kind === 'js' && /(^|\/)cli\.js$/.test(m.path) && m.path.includes('entrypoint'))
    || modules.find(m => m.kind === 'js' && /(^|\/)cli\.js$/.test(m.path));
  if (!cli) throw new Error('cli.js module not found via marker parser');

  log(`Marker parser: found ${cli.path} at offset ${cli.markerStart}, content ${cli.contentLength.toLocaleString()} bytes`);

  const slice = getModuleSlice(buffer, cli, { unwrap: false });
  const text = slice.toString('utf8');
  if (!text.includes('Claude Code')) {
    throw new Error('Marker-extracted cli.js does not contain expected CLI text');
  }
  if (!/^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/.test(text)) {
    throw new Error('Marker-extracted cli.js missing expected CJS wrapper opener');
  }
  // Shebang is prepended by extract() when --executable is passed.
  return text + '\n';
}

/**
 * Extract the CLI’s embedded source string from Claude’s Bun binary (current format).
 *
 * Recent Claude installers ship a large ELF which embeds a Bun “.jsc” payload. That payload
 * contains the minified source text followed by a NUL terminator (and then other binary data).
 *
 * Strategy:
 * - locate a stable CLI anchor string
 * - jump backwards to the beginning of the Bun CJS wrapper for the CLI module
 * - take bytes up to the first NUL after that wrapper start
 */
function extractFromClaudeBunBinary(buffer) {
  const anchors = [
    // Primary anchor — matched in all v2.1.x binaries observed so far.
    // The shorter variants below are defensive fallbacks for very old versions.
    'Claude Code - starts an interactive session by default, use -p/--print for non-interactive output',
    'Claude Code - starts an interactive session',
    "Claude Code is a Beta product per Anthropic's Commercial Terms of Service.",
  ];

  let anchorUsed = null;
  let anchorOffset = -1;
  for (const a of anchors) {
    const idx = buffer.indexOf(Buffer.from(a));
    if (idx !== -1) {
      anchorUsed = a;
      anchorOffset = idx;
      break;
    }
  }

  if (anchorOffset === -1) {
    throw new Error('Could not find any known Claude CLI anchor strings in binary');
  }
  log(`Found CLI anchor at offset ${anchorOffset}: ${JSON.stringify(anchorUsed)}`);

  const wrapperStartMarker = Buffer.from(
    '(function(exports, require, module, __filename, __dirname) {'
  );
  const wrapperStart = buffer.lastIndexOf(wrapperStartMarker, anchorOffset);
  if (wrapperStart === -1) {
    throw new Error('Could not find Bun CJS wrapper start before CLI anchor');
  }
  log(`Module wrapper starts at offset ${wrapperStart}`);

  const endNul = buffer.indexOf(0, wrapperStart);
  if (endNul === -1) {
    throw new Error('Could not find NUL terminator after module wrapper start');
  }

  const len = endNul - wrapperStart;
  log(`Module source ends at offset ${endNul}`);
  log(`Module source size: ${(len / 1024 / 1024).toFixed(2)} MB`);

  if (len < 1024 * 1024) {
    throw new Error(`Extracted source looks too small (${len} bytes)`);
  }

  const source = buffer.slice(wrapperStart, endNul);
  if (source.includes(0)) {
    throw new Error('Internal error: extracted source still contains NUL bytes');
  }

  const text = source.toString('utf8');
  if (!text.includes('Claude Code')) {
    throw new Error('Extracted content does not contain expected CLI text');
  }

  // Shebang is prepended by extract() when --executable is passed.
  return text + '\n';
}


/**
 * Main extraction function
 */
function extract(binaryPath, outputPath) {
  if (!existsSync(binaryPath)) {
    error(`Binary not found: ${binaryPath}`);
  }

  const stats = statSync(binaryPath);
  log(`Binary size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  const buffer = readFileSync(binaryPath);

  if (looksLikePlainJS(buffer)) {
    log('Input appears to be plain JavaScript, copying directly');
    writeFileSync(outputPath, buffer);
    log(`Copied to ${outputPath}`);
    return true;
  }

  try {
    let js;
    let source;
    try {
      js = extractViaMarkerParser(buffer);
      source = 'marker-parser';
    } catch (e) {
      warn(`Marker parser failed (${e.message}); trying legacy anchor heuristic`);
      js = extractFromClaudeBunBinary(buffer);
      source = 'legacy-anchor';
    }
    log(`Extractor used: ${source}`);

    // Fix 4: cross-validation is opt-in via CCPATCH_CROSSVALIDATE=1. The legacy anchor
    // heuristic re-reads the entire binary and is expensive; it's only useful when investigating
    // regressions, so we skip it by default to avoid unnecessary work on every extraction.
    if (source === 'marker-parser' && process.env.CCPATCH_CROSSVALIDATE === '1') {
      try {
        const legacy = extractFromClaudeBunBinary(buffer);
        const a = sha256(Buffer.from(js, 'utf8'));
        const b = sha256(Buffer.from(legacy, 'utf8'));
        if (a === b) {
          log(`Cross-validation: marker parser ↔ legacy anchor MATCH (sha256 ${a.slice(0, 12)}…)`);
        } else {
          warn(`Cross-validation MISMATCH — marker ${a.slice(0, 12)}… vs legacy ${b.slice(0, 12)}… (sizes ${js.length} vs ${legacy.length})`);
          warn(`Using marker-parser output; investigate if patches misbehave.`);
        }
      } catch (e) {
        warn(`Cross-validation skipped: legacy anchor raised (${e.message})`);
      }
    }

    if (js.includes('\u0000')) {
      throw new Error('Extraction produced NUL bytes (output is not clean JS)');
    }
    // Fix 12: only prepend shebang when --executable flag is set.
    if (executableFlag) {
      js = '#!/usr/bin/env node\n' + js;
    }
    // Bun CJS wrapper ends with `})` — not self-invoking under Node.js.
    // Append the call so the extracted file runs as a normal Node.js script.
    const trimmed = js.trimEnd();
    if (trimmed.endsWith('})')) {
      js = trimmed + '(module.exports, require, module, __filename, __dirname);\n';
    }
    writeFileSync(outputPath, js);

    const outStats = statSync(outputPath);
    log(`Success! Extracted ${(outStats.size / 1024 / 1024).toFixed(2)} MB to ${outputPath}`);

    // Show first line
    const firstLine = js.split('\n')[0];
    log(`First line: ${firstLine.slice(0, 60)}...`);

    return true;
  } catch (e) {
    error(`Extraction failed: ${e.message}`);
    return false;
  }
}

// Main
const args = process.argv.slice(2);
if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
  usage();
}

// Fix 12: --executable flag controls whether the shebang is prepended to the output.
// Omit by default — Makefile targets always invoke the output as `node cli.v*.cjs`.
const executableFlag = args.includes('--executable');
const filteredArgs = args.filter(a => a !== '--executable');

const binaryPath = resolve(filteredArgs[0]);
const outputPath = resolve(filteredArgs[1] || 'cli.js');

log(`Extracting JavaScript from: ${binaryPath}`);
log(`Output: ${outputPath}`);

extract(binaryPath, outputPath);

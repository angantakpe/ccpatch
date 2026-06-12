#!/usr/bin/env node
/**
 * src/cli/bin/extract-from-binary.mjs - Extract JavaScript from Bun-compiled binaries
 *
 * Usage:
 *   node src/cli/bin/extract-from-binary.mjs <binary> [output.js]
 *   node src/cli/bin/extract-from-binary.mjs storage/archives/claude-code-v2.1.114/bin/claude.exe cli.js
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * ── Bun SEA (single-executable application) on-disk layout, as reversed here ──
 *
 * `bun build --compile` produces a host-platform executable (ELF on Linux,
 * Mach-O on macOS) with the normal program image first, then Bun's JS runtime,
 * and finally an embedded virtual filesystem ("/$bunfs/root/") near the tail.
 * There is NO separate `node_modules/` tree on disk inside the binary — every
 * application dependency that Bun could bundle is INLINED into the entrypoint
 * module's source text (e.g. react and ink live inside src/entrypoints/cli.js,
 * which is why the react_singleton patch can rewrite the bundled React in place).
 * Dependencies Bun ships as RUNTIME built-ins (notably `ws`, whose
 * WebSocketServer / Sec-WebSocket-* strings sit in the Bun-runtime region, far
 * below the cli.js module) are NOT in the VFS at all — under Node they must come
 * from the host node_modules, which is what the optionalDependencies stopgap
 * provides.
 *
 * Each embedded VFS entry is introduced by an ASCII marker:
 *
 *   JS module (doubled / bytecode-backed):
 *     /$bunfs/root/<path>\0/$bunfs/root/<path>\0// @bun <flags>\n<CJS-wrapper-source>\0
 *   JS module (single):
 *     /$bunfs/root/<path>\0// @bun <flags>\n<CJS-wrapper-source>\0
 *   Native addon (.node, raw ELF/Mach-O):
 *     /$bunfs/root/<path>\0<ELF|MachO image bytes>
 *
 * `<content>` for a JS module is a `(function(exports, require, module,
 * __filename, __dirname){…})` CJS wrapper, NUL-terminated. Native addons are the
 * raw shared-object image (no NUL terminator; the slice runs to the next real
 * marker). The decompiler in tools/bun-decompiler/decompile.mjs walks these
 * markers; we reuse its parser here so this extractor and the native repack path
 * agree byte-for-byte on module boundaries.
 *
 * Observed inventory for claude-code v2.1.x (5 valid headers among 14 raw
 * `/$bunfs/root/` byte occurrences — the other 9 are false positives inside Bun
 * runtime strings, ELF data, and `require("/$bunfs/root/*.node")` string
 * literals, all rejected by parseModuleAt's doubled-path/@bun/ELF checks):
 *   - src/entrypoints/cli.js   (JS, ~16 MB — the real entrypoint; react+ink inline)
 *   - image-processor.js       (JS, tiny CJS wrapper: require("/$bunfs/root/image-processor.node"))
 *   - audio-capture.js         (JS, tiny CJS wrapper: require("/$bunfs/root/audio-capture.node"))
 *   - image-processor.node     (native ELF addon)
 *   - audio-capture.node       (native ELF addon)
 */

/**
 * Build the embedded-module manifest: one record per VFS entry the SEA carries.
 * Each record is { path, kind, offset, size, sha256 } where:
 *   - path    : the /$bunfs/root-relative module path (e.g. "audio-capture.node")
 *   - kind    : "js" | "elf"
 *   - offset  : byte offset of the module's marker within the binary
 *   - size    : on-disk byte length of the extracted slice (post NUL-trim for JS)
 *   - sha256  : hex sha256 of those exact extracted bytes
 */
function buildEmbeddedManifest(buffer) {
  const { modules, markerCount, rawCount } = parseModules(buffer);
  const manifest = [];
  for (const m of modules) {
    const slice = getModuleSlice(buffer, m, { unwrap: false });
    manifest.push({
      path: m.path,
      kind: m.kind,
      offset: m.markerStart,
      size: slice.length,
      sha256: sha256(slice),
    });
  }
  return { manifest, markerCount, rawCount };
}

/**
 * Materialize the complete extraction next to `outputPath` (the cli.js destination):
 *   - <dir>/embedded-manifest.json        — array of {path,kind,offset,size,sha256}
 *   - <dir>/embedded/<path>               — every non-entrypoint VFS entry, so the
 *                                           patched bundle can resolve them at runtime
 *
 * The cli.js entrypoint itself is intentionally NOT re-written under embedded/ —
 * it is the primary output and is written separately by extract(). The native
 * .node addons and their thin JS wrappers ARE written so a runtime
 * `require("/$bunfs/root/<x>")` can be redirected to disk (see esm-compat shim)
 * instead of failing with a swallowed rejection.
 *
 * Returns the manifest array (also when there is nothing extra to extract).
 */
function writeEmbeddedArtifacts(buffer, outputPath) {
  const outDir = dirname(resolve(outputPath));
  const { manifest, markerCount, rawCount } = buildEmbeddedManifest(buffer);

  const manifestPath = join(outDir, 'embedded-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`Embedded manifest: ${manifest.length} entries → ${manifestPath} (${markerCount} markers, ${rawCount} valid headers)`);

  const { modules } = parseModules(buffer);
  let extra = 0;
  for (const m of modules) {
    // Skip the entrypoint module — it's the main `outputPath` written by extract().
    if (/(^|\/)cli\.js$/.test(m.path) && m.path.includes('entrypoint')) continue;
    // Guard against path traversal — only relative, non-escaping paths.
    const dest = resolve(outDir, 'embedded', m.path);
    if (dest !== resolve(outDir, 'embedded') && !dest.startsWith(resolve(outDir, 'embedded') + '/')) {
      warn(`Refusing to extract embedded module with unsafe path: ${m.path}`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, getModuleSlice(buffer, m, { unwrap: false }));
    extra++;
    log(`  embedded: ${m.kind === 'elf' ? '[native]' : '[js]    '} ${m.path} → embedded/${m.path}`);
  }
  if (extra === 0) {
    log('  (no non-entrypoint embedded modules found)');
  }
  return manifest;
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

    // Completeness pass: enumerate ALL embedded VFS entries (not just cli.js),
    // write the manifest, and materialize the non-entrypoint modules under
    // <dir>/embedded/ so the patched bundle can resolve them at runtime. Fail
    // loud at extract time: a malformed binary here is a hard error, not a
    // silent partial extraction.
    try {
      writeEmbeddedArtifacts(buffer, outputPath);
    } catch (e) {
      error(`Embedded-module extraction failed: ${e.message}`);
    }

    return true;
  } catch (e) {
    error(`Extraction failed: ${e.message}`);
    return false;
  }
}

// Exported for unit tests (synthetic SEA fixtures); the CLI body below only runs
// when this file is invoked directly, so importing it has no side effects.
export { buildEmbeddedManifest, writeEmbeddedArtifacts };

// `executableFlag` is read inside extract(); declare at module scope so both the
// CLI path and any test that calls extract() resolve the same binding.
let executableFlag = false;

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
    usage();
  }

  // Fix 12: --executable flag controls whether the shebang is prepended to the output.
  // Omit by default — Makefile targets always invoke the output as `node cli.v*.cjs`.
  executableFlag = args.includes('--executable');
  const filteredArgs = args.filter(a => a !== '--executable');

  const binaryPath = resolve(filteredArgs[0]);
  const outputPath = resolve(filteredArgs[1] || 'cli.js');

  log(`Extracting JavaScript from: ${binaryPath}`);
  log(`Output: ${outputPath}`);

  extract(binaryPath, outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

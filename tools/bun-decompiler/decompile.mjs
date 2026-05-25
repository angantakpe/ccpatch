#!/usr/bin/env node
// Bun standalone executable decompiler.
//
// Extracts user-code modules from a `bun build --compile` binary by locating
// the Bun module markers — NOT by heuristic text-scanning (which produces
// false positives from Bun's own runtime strings).
//
// Module marker formats (observed in Bun 1.x compiled binaries):
//   Doubled (bytecode-backed): /$bunfs/root/<path>\x00/$bunfs/root/<path>\x00// @bun <flags>\n<content>
//   Single:                    /$bunfs/root/<path>\x00// @bun <flags>\n<content>
//   ELF native (.node):        /$bunfs/root/<path>\x00\x7fELF<ELF binary>
// Each JS module's <content> is a CJS wrapper `(function(exports, require, module, ...)`.
// Module ends at the next real marker or EOF (last JS module: NUL-terminated, so first NUL
// after contentStart is used to exclude Bun's trailer struct). False markers inside string
// literals (e.g. `require("/$bunfs/root/x.node")`) are filtered by the doubled-path / @bun
// header checks in parseModuleAt — not by a NUL-prefix guard.
//
// Usage:
//   node src/cli/decompilers/bun/decompile.mjs <binary> [--out <dir>]
//
// Output: each module is written with its CJS wrapper intact (unwrap: false).
// Consumers that want the raw inner body should call getModuleSlice(buf, m, { unwrap: true }).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNFS_PREFIX = Buffer.from('/$bunfs/root/');
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

export { BUNFS_PREFIX, ELF_MAGIC };

function parseArgs(argv) {
  const out = { binary: null, outDir: null, entrypoint: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = argv[++i];
    else if (a === '--entrypoint') out.entrypoint = argv[++i];
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (!out.binary) out.binary = a;
    else { console.error(`Unknown arg: ${a}`); usage(); process.exit(1); }
  }
  if (!out.binary) { usage(); process.exit(1); }
  if (!out.outDir) out.outDir = path.join(path.dirname(path.resolve(out.binary)), 'decompiled');
  return out;
}

function usage() {
  console.error('Usage: bun-decompile <binary> [--out <dir>] [--entrypoint <path>]');
}

function resolveSafeOutputPath(outDir, modulePath) {
  const root = path.resolve(outDir);
  const resolved = path.resolve(root, modulePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Unsafe module path escapes output directory: ${modulePath}`);
  }
  return resolved;
}

function findAll(buf, needle, from = 0) {
  const hits = [];
  let i = from;
  while ((i = buf.indexOf(needle, i)) !== -1) {
    hits.push(i);
    i += needle.length;
  }
  return hits;
}

function readPath(buf, start) {
  // Read NUL-terminated path starting right after BUNFS_PREFIX match position.
  // Returns { path, pathEnd } where pathEnd is the position of the terminating NUL.
  const nul = buf.indexOf(0x00, start);
  if (nul < 0) return null;
  return { path: buf.slice(start, nul).toString('utf8'), pathEnd: nul };
}

function parseModuleAt(buf, markerStart) {
  // markerStart points to BUNFS_PREFIX occurrence.
  // Full header: /$bunfs/root/<path>\x00/$bunfs/root/<path>\x00// @bun <flags>\n
  const pathStart = markerStart + BUNFS_PREFIX.length;
  const first = readPath(buf, pathStart);
  if (!first) return null;
  const modPath = first.path;

  // Fix 2: use pre-built doubled-path needle (no Buffer.concat per call).
  // Must be followed by a second occurrence of the same path.
  const doubled = Buffer.from('//root/' + modPath + '\0//root/' + modPath + '\0');
  if (buf.slice(markerStart, markerStart + doubled.length).equals(doubled)) {
    // JS module — doubled path
    const flagsStart = markerStart + doubled.length;
    const newline = buf.indexOf(0x0A, flagsStart);
    if (newline < 0) return null;
    const flags = buf.slice(flagsStart, newline).toString('utf8');
    return {
      kind: 'js',
      path: modPath,
      markerStart,
      contentStart: newline + 1,
      flags,
    };
  }

  // Single-path JS module: /$bunfs/root/<path>\x00// @bun <flags>\n<content>
  // Fix 1: search for @bun within the next ~32 bytes after the NUL — more resilient than
  // checking exact 0x2F 0x2F bytes, handles whitespace changes between Bun releases.
  const afterNul = buf.slice(first.pathEnd + 1, first.pathEnd + 33);
  if (afterNul.indexOf(Buffer.from('@bun')) !== -1) {
    const flagsStart = first.pathEnd + 1;
    const newline = buf.indexOf(0x0A, flagsStart);
    if (newline < 0) return null;
    const flags = buf.slice(flagsStart, newline).toString('utf8');
    if (!flags.includes('@bun')) return null;
    return {
      kind: 'js',
      path: modPath,
      markerStart,
      contentStart: newline + 1,
      flags,
    };
  }

  // ELF native module — check for \x7fELF right after path NUL
  if (buf.slice(first.pathEnd + 1, first.pathEnd + 5).equals(ELF_MAGIC)) {
    return {
      kind: 'elf',
      path: modPath,
      markerStart,
      contentStart: first.pathEnd + 1,
      flags: '',
    };
  }

  return null;
}

function dedupeModules(modules) {
  // Bun stores doubled modules (bytecode-backed): the outer header (A) parses as doubled-path
  // with contentEnd = B.markerStart, giving contentLength < 0 (contentStart is after B).
  // The inner header (B) parses as single-path with contentEnd = C.markerStart — positive
  // contentLength. Keeping largest contentLength correctly selects B.
  const byPath = new Map();
  for (const m of modules) {
    const prev = byPath.get(m.path);
    if (!prev || m.contentLength > prev.contentLength) byPath.set(m.path, m);
  }
  return Array.from(byPath.values());
}

export function parseModules(buf) {
  const markerHits = findAll(buf, BUNFS_PREFIX);
  const raw = [];
  for (const off of markerHits) {
    const m = parseModuleAt(buf, off);
    if (m) raw.push(m);
  }
  raw.sort((a, b) => a.markerStart - b.markerStart);
  for (let i = 0; i < raw.length; i++) {
    const next = raw[i + 1];
    const nextBoundary = next ? next.markerStart : buf.length;
    if (raw[i].kind === 'js') {
      // Bun NUL-terminates every JS module's source text. Using the first NUL after
      // contentStart keeps content clean: it excludes adjacent module headers (for
      // non-last modules) and Bun's trailer struct (for the last module). Falls back
      // to nextBoundary if no NUL is found within range (shouldn't happen for real JS).
      const nul = buf.indexOf(0x00, raw[i].contentStart);
      raw[i].contentEnd = (nul > raw[i].contentStart && nul < nextBoundary) ? nul : nextBoundary;
    } else {
      // Fix 6: validate that the next marker position is a real module header, not a false
      // positive /$bunfs/root/ sequence embedded inside ELF binary data. A real path starts
      // with '/' or alphanumeric, is printable ASCII throughout, and has a NUL within 256 bytes.
      let boundary = nextBoundary;
      if (next) {
        let scanPos = next.markerStart;
        // If the apparent next marker doesn't look like a real header, scan forward.
        let pos = scanPos;
        while (pos < buf.length) {
          const pathStart = pos + BUNFS_PREFIX.length;
          const sampleEnd = Math.min(pathStart + 256, buf.length);
          const sample = buf.slice(pathStart, sampleEnd);
          const nulInSample = sample.indexOf(0x00);
          if (nulInSample > 0) {
            const pathBytes = sample.slice(0, nulInSample);
            const first2 = pathBytes[0];
            const plausibleStart = first2 === 0x2F ||
              (first2 >= 0x30 && first2 <= 0x39) ||
              (first2 >= 0x41 && first2 <= 0x5A) ||
              (first2 >= 0x61 && first2 <= 0x7A);
            let printable = plausibleStart;
            if (printable) {
              for (const b of pathBytes) {
                if (b < 0x20 || b > 0x7E) { printable = false; break; }
              }
            }
            if (printable) { boundary = pos; break; }
          }
          const nextPos = buf.indexOf(BUNFS_PREFIX, pos + BUNFS_PREFIX.length);
          if (nextPos === -1) { boundary = buf.length; break; }
          pos = nextPos;
        }
      }
      raw[i].contentEnd = boundary;
    }
    raw[i].contentLength = raw[i].contentEnd - raw[i].contentStart;
  }
  const modules = dedupeModules(raw);
  modules.sort((a, b) => a.path.localeCompare(b.path));
  return { modules, markerCount: markerHits.length, rawCount: raw.length };
}

export function getModuleSlice(buf, m, { unwrap = true, outDir = null } = {}) {
  // Fix 11: path traversal guard — throws if module path would escape outDir.
  // Library callers writing to disk should pass outDir so unsafe paths are rejected early.
  if (outDir != null) {
    resolveSafeOutputPath(outDir, m.path); // throws on traversal attempt
  }
  let slice = buf.subarray(m.contentStart, m.contentEnd);
  if (m.kind !== 'js') return slice;
  let end = slice.length;
  while (end > 0 && slice[end - 1] === 0x00) end--;
  slice = slice.subarray(0, end);
  if (!unwrap) return slice;
  const txt = slice.toString('utf8');
  const openRe = /^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/;
  const openMatch = openRe.exec(txt);
  if (!openMatch) return slice;
  let tEnd = txt.length;
  while (tEnd > 0 && (txt[tEnd - 1] === '\n' || txt[tEnd - 1] === '\r' || txt[tEnd - 1] === ' ' || txt[tEnd - 1] === '\t')) tEnd--;
  if (tEnd >= 2 && txt.slice(tEnd - 2, tEnd) === '})') {
    const inner = txt.slice(openMatch[0].length, tEnd - 2);
    return Buffer.from(inner, 'utf8');
  }
  return slice;
}

function main() {
  const args = parseArgs(process.argv);
  const buf = fs.readFileSync(args.binary);
  console.log(`Binary: ${args.binary}`);
  console.log(`Size:   ${buf.length.toLocaleString()} bytes`);

  const { modules, markerCount, rawCount } = parseModules(buf);
  console.log(`Markers: ${markerCount} /$bunfs/root/ occurrences`);
  console.log(`Parsed:  ${rawCount} valid module headers`);
  console.log(`Unique:  ${modules.length} modules after dedup`);

  fs.mkdirSync(args.outDir, { recursive: true });
  const manifest = [];
  for (const m of modules) {
    const outPath = resolveSafeOutputPath(args.outDir, m.path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let slice = getModuleSlice(buf, m, { unwrap: false });
    // Fix 7: flexible entrypoint detection — append self-invocation when the module ends with `})`
    // (CJS wrapper without a call expression). --entrypoint <path> forces the suffix onto a specific
    // module path; default falls back to /src/entrypoints/ regex for backwards compatibility.
    const isEntrypoint = args.entrypoint
      ? m.path === args.entrypoint
      : (m.kind === 'js' && /src\/entrypoints\//.test(m.path));
    if (isEntrypoint) {
      const txt = slice.toString('utf8').trimEnd();
      if (txt.endsWith('})')) {
        slice = Buffer.from(txt + '(module.exports, require, module, __filename, __dirname);\n', 'utf8');
      }
    }
    fs.writeFileSync(outPath, slice);
    manifest.push({
      path: m.path,
      kind: m.kind,
      flags: m.flags,
      markerStart: m.markerStart,
      contentStart: m.contentStart,
      contentLength: m.contentLength,
    });
    console.log(`  ${m.kind === 'elf' ? '[ELF]' : '[JS] '} ${m.path.padEnd(40)} ${m.contentLength.toLocaleString()} bytes  flags=${m.flags}`);
  }

  fs.writeFileSync(path.join(args.outDir, 'manifest.json'), JSON.stringify({
    binary: path.resolve(args.binary),
    size: buf.length,
    extractedAt: new Date().toISOString(),
    modules: manifest,
  }, null, 2));

  console.log(`\nWrote ${modules.length} modules to ${args.outDir}`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

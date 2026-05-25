// Bun runtime shim for Node.js — makes decompiled Bun bundles runnable on plain Node.
//
// Usage:
//   BUN_SHIM_ROOT=/path/to/decompiled node --require ./src/cli/decompilers/bun/shim.cjs <entrypoint.js> [args...]
//
// Env:
//   BUN_SHIM_ROOT   Directory the decompiler wrote (replaces /$bunfs/root/ at require time).
//   BUN_SHIM_DEBUG  "1" to log shimmed API calls + require redirects.
//
// Scope: covers Bun APIs actually reached by Claude Code's CLI bundle. Feature-detected
// branches in the bundle (`typeof Bun<"u"`) make most APIs optional — we stub the rest
// with faithful-enough implementations using only Node builtins.

'use strict';

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const util = require('node:util');
const v8 = require('node:v8');

const BUNFS_PREFIX = '/$bunfs/root/';
const DEBUG = process.env.BUN_SHIM_DEBUG === '1';
const ROOT = process.env.BUN_SHIM_ROOT;

if (!ROOT) {
  console.error('[bun-shim] BUN_SHIM_ROOT env var required (directory produced by bun-decompile.mjs)');
  process.exit(2);
}
if (!fs.existsSync(ROOT)) {
  console.error(`[bun-shim] BUN_SHIM_ROOT does not exist: ${ROOT}`);
  process.exit(2);
}

function dbg(...args) { if (DEBUG) console.error('[bun-shim]', ...args); }

// --- require() redirection ---------------------------------------------------
// Map /$bunfs/root/<path> → ROOT/<path>; stub bun:ffi / bun:jsc / bun:sqlite.

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (typeof request === 'string') {
    if (request.startsWith(BUNFS_PREFIX)) {
      const rel = request.slice(BUNFS_PREFIX.length);
      const mapped = path.join(ROOT, rel);
      dbg('resolve', request, '→', mapped);
      return origResolve.call(this, mapped, parent, ...rest);
    }
    if (request === 'bun:ffi' || request === 'bun:jsc' || request === 'bun:sqlite') {
      return request; // handled in _load
    }
  }
  return origResolve.call(this, request, parent, ...rest);
};

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'bun:ffi') {
    dbg('load bun:ffi (stub)');
    return {
      dlopen() { throw new Error('bun:ffi.dlopen not supported under bun-shim'); },
      FFIType: new Proxy({}, { get: (_, k) => String(k) }),
      suffix: process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so',
      ptr: () => 0n,
      read: new Proxy({}, { get: () => () => 0 }),
      CString: class CString { constructor(ptr) { this.ptr = ptr; } toString() { return ''; } },
      JSCallback: class JSCallback { constructor(fn) { this.fn = fn; } close() {} },
    };
  }
  if (request === 'bun:jsc') {
    dbg('load bun:jsc (stub)');
    return {
      serialize: (v) => v8.serialize(v),
      deserialize: (buf) => v8.deserialize(buf),
      estimateShallowMemoryUsageOf: () => 0,
      heapSize: () => process.memoryUsage().heapUsed,
    };
  }
  if (request === 'bun:sqlite') {
    dbg('load bun:sqlite (stub)');
    // Throw at call time, not at require() time — eager imports must not crash startup.
    return new Proxy({}, { get: (_, k) => () => { throw new Error(`bun:sqlite.${String(k)} not supported under bun-shim`); } });
  }
  return origLoad.call(this, request, parent, ...rest);
};

// --- globalThis.Bun ----------------------------------------------------------

function hashWyhash(data, seed = 0n) {
  // Bun.hash() uses wyhash by default. We substitute a fast cryptographic digest
  // and truncate to 64 bits — collision behavior differs from real wyhash, but
  // no code path compares hashes against Bun-generated values on-disk.
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const h = crypto.createHash('sha256').update(buf).digest();
  // Bun.hash() returns number (lossy float64), not BigInt — match that to avoid TypeError.
  return Number(h.readBigUInt64LE(0) ^ BigInt(seed));
}

const SemVer = {
  _parse(v) {
    const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] || '' };
  },
  order(a, b) {
    const A = SemVer._parse(a), B = SemVer._parse(b);
    if (!A || !B) return 0;
    if (A.maj !== B.maj) return A.maj - B.maj;
    if (A.min !== B.min) return A.min - B.min;
    if (A.pat !== B.pat) return A.pat - B.pat;
    if (A.pre && !B.pre) return -1;
    if (!A.pre && B.pre) return 1;
    return A.pre.localeCompare(B.pre);
  },
  satisfies(version, range) {
    const v = SemVer._parse(version);
    if (!v) return false;
    const clauses = String(range).split(/\s*\|\|\s*/);
    for (const clause of clauses) {
      const parts = clause.trim().split(/\s+/);
      let ok = true;
      for (const p of parts) {
        const m = p.match(/^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (!m) { ok = false; break; }
        const op = m[1] || '=';
        const target = { maj: +m[2], min: +(m[3] || 0), pat: +(m[4] || 0), pre: '' };
        const cmp = SemVer.order(v, target);
        if (op === '>=' && !(cmp >= 0)) ok = false;
        else if (op === '<=' && !(cmp <= 0)) ok = false;
        else if (op === '>' && !(cmp > 0)) ok = false;
        else if (op === '<' && !(cmp < 0)) ok = false;
        else if (op === '=' && cmp !== 0) ok = false;
        else if (op === '^') {
          if (v.maj !== target.maj) ok = false;
          else if (cmp < 0) ok = false;
        } else if (op === '~') {
          if (v.maj !== target.maj || v.min !== target.min) ok = false;
          else if (cmp < 0) ok = false;
        }
        if (!ok) break;
      }
      if (ok) return true;
    }
    return false;
  },
  variant(v) {
    const parsed = SemVer._parse(v);
    if (!parsed) return 'invalid';
    return parsed.pre ? 'prerelease' : 'stable';
  },
};

function stripANSI(s) { return String(s).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''); }

function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7F && cp < 0xA0)) return 0;
  // Rough wide-char ranges (CJK, full-width, emoji). Good enough for TUI width.
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF) ||
    (cp >= 0x20000 && cp <= 0x2FFFD) ||
    (cp >= 0x30000 && cp <= 0x3FFFD)
  ) return 2;
  return 1;
}

function stringWidth(s) {
  const stripped = stripANSI(s);
  let w = 0;
  for (const ch of stripped) w += charWidth(ch.codePointAt(0));
  return w;
}

function wrapAnsi(s, cols = 80) {
  // Minimal greedy wrap. Uses stringWidth (ANSI-aware) for column counting.
  const words = String(s).split(/(\s+)/);
  let line = '', out = '', lineW = 0;
  for (const w of words) {
    const ww = stringWidth(w);
    if (lineW + ww > cols && line) {
      out += line + '\n';
      line = w.trimStart();
      lineW = stringWidth(line);
    } else {
      line += w;
      lineW += ww;
    }
  }
  return out + line;
}

function bunSpawn(opts) {
  // Accept either Bun shape (cmd: [...], stdio: [...]) or array-first positional.
  const o = Array.isArray(opts) ? { cmd: opts } : { ...opts };
  const [file, ...args] = o.cmd;
  const stdio = o.stdio || ['inherit', 'pipe', 'pipe'];
  const child = childProcess.spawn(file, args, {
    cwd: o.cwd,
    env: o.env || process.env,
    stdio: stdio.map(s => s === 'ignore' ? 'ignore' : s === 'inherit' ? 'inherit' : 'pipe'),
  });
  const wrap = {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise(res => child.on('exit', code => res(code ?? 0))),
    exitCode: null,
    kill(sig) { child.kill(sig); },
    ref() { child.ref && child.ref(); },
    unref() { child.unref && child.unref(); },
  };
  child.on('exit', code => { wrap.exitCode = code; });
  return wrap;
}

function bunSpawnSync(opts) {
  const o = Array.isArray(opts) ? { cmd: opts } : { ...opts };
  const [file, ...args] = o.cmd;
  const r = childProcess.spawnSync(file, args, {
    cwd: o.cwd,
    env: o.env || process.env,
    input: o.stdin,
    encoding: 'buffer',
  });
  return {
    exitCode: r.status ?? 0,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
    success: (r.status ?? 0) === 0,
    signalCode: r.signal,
  };
}

function bunListen(opts) {
  const server = net.createServer();
  if (opts.socket && opts.socket.data) server.on('connection', s => opts.socket.data(s, Buffer.alloc(0)));
  server.listen(opts.port, opts.hostname || '0.0.0.0');
  return { stop: () => server.close(), hostname: opts.hostname || '0.0.0.0', port: opts.port, unref: () => server.unref() };
}

function bunWhich(name, opts = {}) {
  const PATH = (opts.PATH || process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of PATH) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

function yamlParse(src) {
  // Flat-only YAML subset: top-level `key: value` scalar pairs only.
  // The CLI bundle only uses YAML for flat release metadata; anything deeper needs a real YAML dep.
  const lines = String(src).split(/\r?\n/);
  const root = {};
  let lineNum = 0;
  for (const raw of lines) {
    lineNum++;
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    // Fix 8: warn on list lines and nested structures instead of silently skipping.
    if (/^\s*-\s/.test(line)) {
      console.warn(`[shim] Bun.YAML.parse: unsupported structure at line ${lineNum} (list item) — skipped`);
      continue;
    }
    if (/^\s{2,}\S/.test(line)) {
      // Extract the last parsed key name for a useful warning.
      const lastKey = Object.keys(root).pop() || '(unknown)';
      console.warn(`[shim] Bun.YAML.parse: unsupported structure at line ${lineNum} — returning null for key ${lastKey}`);
      root[lastKey] = null;
      continue;
    }
    const m = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null' || v === '~' || v === '') v = null;
    else if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
    root[m[1]] = v;
  }
  return root;
}

function yamlStringify(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    out.push(`${k}: ${v === null ? 'null' : JSON.stringify(v)}`);
  }
  return out.join('\n') + '\n';
}

// Word-boundary-anchored to avoid matching minified JS identifiers like
// `string_var`, `numberOfItems`, `booleanFlag`, `stringify`, `typeof`.
const TS_SYNTAX = /(?:: string|: number|: boolean)\b|\binterface\s|\benum\s|\bas const\b|<T>|\bimport type\b|\bexport type\b/;

class Transpiler {
  constructor(opts) { this.opts = opts || {}; }
  transformSync(src) {
    const s = String(src);
    if (TS_SYNTAX.test(s)) {
      throw new Error('bun-shim: Bun.Transpiler cannot transpile TypeScript — install real Bun or pre-transpile');
    }
    return s;
  }
  transform(src) {
    const s = String(src);
    if (TS_SYNTAX.test(s)) {
      return Promise.reject(new Error('bun-shim: Bun.Transpiler cannot transpile TypeScript — install real Bun or pre-transpile'));
    }
    return Promise.resolve(s);
  }
  scan() { return { imports: [], exports: [] }; }
  scanImports() { return []; }
}

const START_NS = process.hrtime.bigint();
const SLEEP_SYNC_I32 = new Int32Array(new SharedArrayBuffer(4));

globalThis.Bun = {
  version: process.env.BUN_SHIM_VERSION || '1.3.0',
  revision: 'bun-shim (not real Bun)',
  main: process.argv[1] || '',
  argv: process.argv,
  env: process.env,
  inspect: util.inspect,
  nanoseconds: () => Number(process.hrtime.bigint() - START_NS),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  sleepSync: (ms) => { if (ms > 0) Atomics.wait(SLEEP_SYNC_I32, 0, 0, ms); },
  hash: Object.assign((d, s) => hashWyhash(d, s), {
    wyhash: (d, s) => hashWyhash(d, s),
    crc32: (() => {
      const zlibCrc32 = require('node:zlib').crc32;
      if (zlibCrc32) {
        return (d) => zlibCrc32(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
      }
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
      }
      return (d) => {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
        let crc = 0xFFFFFFFF;
        for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF];
        return ((crc ^ 0xFFFFFFFF) >>> 0);
      };
    })(),
    adler32: (d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      let a = 1, b = 0;
      for (const byte of buf) { a = (a + byte) % 65521; b = (b + a) % 65521; }
      return (b << 16) | a;
    },
  }),
  semver: SemVer,
  spawn: bunSpawn,
  spawnSync: bunSpawnSync,
  listen: bunListen,
  which: bunWhich,
  wrapAnsi,
  stripANSI,
  stringWidth,
  YAML: { parse: yamlParse, stringify: yamlStringify },
  JSONL: {
    parseChunk(chunk) {
      return String(chunk).split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x !== null);
    },
  },
  Transpiler,
  embeddedFiles: [],
  gc: (sync) => { if (global.gc) global.gc(); return 0; },
  generateHeapSnapshot: () => v8.getHeapSnapshot(),
  peek: (p) => p,
  isMainThread: true,
  pathToFileURL: (p) => require('node:url').pathToFileURL(p),
  fileURLToPath: (u) => require('node:url').fileURLToPath(u),
  write: async (dest, data) => {
    if (typeof dest === 'string') { fs.writeFileSync(dest, data); return data.length || 0; }
    return 0;
  },
  file: (p) => ({
    name: p,
    size: fs.existsSync(p) ? fs.statSync(p).size : 0,
    text: async () => fs.readFileSync(p, 'utf8'),
    json: async () => JSON.parse(fs.readFileSync(p, 'utf8')),
    arrayBuffer: async () => fs.readFileSync(p).buffer,
    exists: async () => fs.existsSync(p),
  }),
  // Fix 14: pass { filename: from || '' } instead of { filename, paths: [...] }.
  // Module._resolveFilename uses filename for directory context; paths array is not needed for CJS.
  resolveSync: (req, from) => origResolve.call(Module, req, { filename: from || '' }),
  $: (strings, ...values) => {
    // Bun's shell-template — degrade to string concat then spawnSync.
    let cmd = '';
    strings.forEach((s, i) => { cmd += s + (values[i] !== undefined ? String(values[i]) : ''); });
    return bunSpawnSync({ cmd: [process.env.SHELL || '/bin/sh', '-c', cmd] });
  },
};

// Bun exposes $bunfs as a virtual read-only fs — most uses are fs.readFileSync
// against `/$bunfs/root/...`, which _resolveFilename already remaps. Expose a
// tiny wrapper for direct `$bunfs` reads just in case.
globalThis.$bunfs = {
  readFileSync: (p, enc) => {
    const rel = p.startsWith(BUNFS_PREFIX) ? p.slice(BUNFS_PREFIX.length) : p;
    return fs.readFileSync(path.join(ROOT, rel), enc);
  },
  existsSync: (p) => {
    const rel = p.startsWith(BUNFS_PREFIX) ? p.slice(BUNFS_PREFIX.length) : p;
    return fs.existsSync(path.join(ROOT, rel));
  },
};

dbg(`ready — ROOT=${ROOT}`);

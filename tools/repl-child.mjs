/**
 * tools/repl-child.mjs — child process wrapper for `ccpatch repl`.
 *
 * Spawned by tools/repl.mjs. Imports the patched bundle so that the
 * contracts kernel (and any `__ccpProvide` calls from overlay/inline patches)
 * populates `globalThis.__ccpRegistry`. Then reads newline-delimited
 * expressions from stdin and writes JSON-line responses to stdout on fd 3.
 *
 * Wire protocol (one JSON object per line, in BOTH directions):
 *   →  { id, expr }                  evaluate expr
 *   ←  { id, ok: true, value }       value is a JSON-safe summary
 *   ←  { id, ok: false, error }
 *
 * stdout/stderr of the loaded bundle remain piped to the parent (which
 * buffers them and flushes between prompts so they don't trample readline).
 * The IPC channel is fd 3, opened by the parent.
 *
 * Usage:
 *   node tools/repl-child.mjs <bundle-path>
 */

import { pathToFileURL } from 'node:url';
import { createWriteStream } from 'node:fs';
import vm from 'node:vm';

const bundlePath = process.argv[2];
if (!bundlePath) {
  process.stderr.write('repl-child: missing bundle path\n');
  process.exit(2);
}

// Open the IPC channel on fd 3 (parent set this up via stdio[3] = 'pipe').
const ipc = createWriteStream(null, { fd: 3 });
function send(obj) { ipc.write(JSON.stringify(obj) + '\n'); }

// Try to import the bundle. If it throws (e.g. main() crashes after
// registry init), we still want the REPL alive — registry state set up
// before the throw is observable.
try {
  await import(pathToFileURL(bundlePath).href);
} catch (err) {
  process.stderr.write(`[repl-child] bundle import threw: ${err && err.message}\n`);
}

// Signal ready. Send registry snapshot so parent can print it.
function snapshot() {
  const reg = globalThis.__ccpRegistry;
  if (!reg || typeof reg.forEach !== 'function') return null;
  const out = {};
  reg.forEach((entry, name) => {
    out[name] = {
      producer: entry.producer,
      version: entry.version,
      shape: Array.isArray(entry.shape) ? entry.shape.slice() : [],
      valueType: typeof entry.value,
    };
  });
  return out;
}
send({ ready: true, registry: snapshot() });

// JSON-safe serialiser. Functions → '[Function]'; circular → '[Circular]'.
function safeValue(v, depth = 0) {
  if (v === undefined) return { __type: 'undefined' };
  if (v === null) return null;
  const t = typeof v;
  if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (t === 'symbol') return v.toString();
  if (t === 'bigint') return v.toString() + 'n';
  if (t !== 'object') return v;
  if (depth > 3) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => safeValue(x, depth + 1));
  try {
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ > 20) { out['…'] = `+${Object.keys(v).length - 20} more`; break; }
      try { out[k] = safeValue(v[k], depth + 1); } catch { out[k] = '[Throwing getter]'; }
    }
    return out;
  } catch {
    return String(v);
  }
}

// Shared context: bundle globals + sugar.
const ctx = vm.createContext(globalThis);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle({ id, expr }) {
  try {
    // Wrap in `(async () => (expr))()` so `await` works inline.
    const wrapped = `(async () => (${expr}))()`;
    let value;
    try {
      value = await vm.runInContext(wrapped, ctx, { timeout: 4500 });
    } catch (e) {
      // Statement-form fallback (e.g. `var x = 1`).
      value = await vm.runInContext(`(async () => { ${expr} ; })()`, ctx, { timeout: 4500 });
    }
    send({ id, ok: true, value: safeValue(value) });
  } catch (err) {
    send({ id, ok: false, error: (err && err.stack) || String(err) });
  }
}

/**
 * tools/repl.mjs — parent-side REPL for `ccpatch repl <patched-bundle>`.
 *
 * Spawns tools/repl-child.mjs in a child node process with the bundle path.
 * Forwards every input line to the child via stdin (newline-delimited JSON),
 * reads responses on fd 3, prints them. Reserves a `:` prefix for REPL
 * meta-commands: `:list`, `:reload`, `:quit`, `:help`.
 *
 * Works without a TTY (tests pipe stdin/stdout).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(__dirname, 'repl-child.mjs');

const EVAL_TIMEOUT_MS = 5000;

/**
 * Spawn the child wrapper. Returns an object with helpers for talking to it.
 * Buffers child stdout/stderr so they can be flushed between prompts.
 */
function spawnChild(bundlePath) {
  const child = spawn(process.execPath, [CHILD_SCRIPT, bundlePath], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // 0=stdin 1=stdout 2=stderr 3=ipc
  });

  const state = {
    child,
    pending: new Map(), // id -> { resolve, reject, timer }
    nextId: 1,
    readyPromise: null,
    readyResolve: null,
    registry: null,
    outputBuf: '',
    ipcBuf: '',
    exited: false,
  };

  state.readyPromise = new Promise(r => { state.readyResolve = r; });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdio[3].setEncoding('utf8');

  child.stdout.on('data', d => { state.outputBuf += d; });
  child.stderr.on('data', d => { state.outputBuf += d; });

  child.stdio[3].on('data', d => {
    state.ipcBuf += d;
    let nl;
    while ((nl = state.ipcBuf.indexOf('\n')) !== -1) {
      const line = state.ipcBuf.slice(0, nl);
      state.ipcBuf = state.ipcBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) {
        state.registry = msg.registry;
        state.readyResolve();
        continue;
      }
      const slot = state.pending.get(msg.id);
      if (!slot) continue;
      state.pending.delete(msg.id);
      clearTimeout(slot.timer);
      slot.resolve(msg);
    }
  });

  child.on('exit', () => {
    state.exited = true;
    for (const slot of state.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error('child exited'));
    }
    state.pending.clear();
  });

  return state;
}

function flushChildOutput(state, out) {
  if (state.outputBuf) {
    out.write(state.outputBuf);
    if (!state.outputBuf.endsWith('\n')) out.write('\n');
    state.outputBuf = '';
  }
}

function evalInChild(state, expr) {
  if (state.exited) return Promise.reject(new Error('child not running'));
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      try { state.child.kill('SIGKILL'); } catch {}
      reject(new Error(`eval timed out after ${EVAL_TIMEOUT_MS}ms (child killed)`));
    }, EVAL_TIMEOUT_MS);
    state.pending.set(id, { resolve, reject, timer });
    state.child.stdin.write(JSON.stringify({ id, expr }) + '\n');
  });
}

function formatValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object' && v && v.__type === 'undefined') return 'undefined';
  return JSON.stringify(v, null, 2);
}

function formatRegistry(reg) {
  if (!reg || Object.keys(reg).length === 0) {
    return '(empty)';
  }
  const lines = [];
  const names = Object.keys(reg).sort();
  for (const name of names) {
    const e = reg[name];
    const shape = e.shape && e.shape.length ? ` shape=[${e.shape.join(', ')}]` : '';
    lines.push(`  ${name.padEnd(28)} producer=${e.producer} v${e.version} type=${e.valueType}${shape}`);
  }
  return lines.join('\n');
}

/**
 * Run the REPL. `io` is an object { input, output, prompt? }; defaults to
 * process.stdin/stdout. Returns a promise that resolves when the REPL exits.
 */
export async function runRepl(bundlePath, io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const prompt = io.prompt ?? 'ccp> ';

  let state = spawnChild(bundlePath);
  await state.readyPromise;
  flushChildOutput(state, output);

  if (state.registry == null) {
    output.write('no ccpatch contracts registered — was `contracts` patch enabled?\n');
  } else {
    output.write(`__ccpRegistry: ${Object.keys(state.registry).length} entries\n`);
    if (Object.keys(state.registry).length > 0) {
      output.write(formatRegistry(state.registry) + '\n');
    }
  }

  const rl = readline.createInterface({
    input,
    output,
    prompt,
    terminal: false, // critical: tests pipe stdin
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    if (trimmed.startsWith(':')) {
      const [cmd] = trimmed.slice(1).split(/\s+/);
      if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
        rl.close();
        return;
      }
      if (cmd === 'help' || cmd === 'h') {
        output.write(':list           list __ccpRegistry entries\n');
        output.write(':reload         re-spawn the child (registry repopulates)\n');
        output.write(':quit           exit\n');
        rl.prompt();
        return;
      }
      if (cmd === 'list') {
        // Re-snapshot in case the bundle added entries lazily.
        try {
          const res = await evalInChild(state, '(globalThis.__ccpInspectContracts ? globalThis.__ccpInspectContracts() : (globalThis.__ccpRegistry ? Array.from(globalThis.__ccpRegistry.keys()) : []))');
          flushChildOutput(state, output);
          output.write(formatValue(res.ok ? res.value : res.error) + '\n');
        } catch (err) {
          output.write(`error: ${err.message}\n`);
        }
        rl.prompt();
        return;
      }
      if (cmd === 'reload') {
        try { state.child.kill(); } catch {}
        state = spawnChild(bundlePath);
        await state.readyPromise;
        flushChildOutput(state, output);
        output.write(`[reloaded] __ccpRegistry: ${state.registry ? Object.keys(state.registry).length : 0} entries\n`);
        rl.prompt();
        return;
      }
      output.write(`unknown meta-command: :${cmd} (try :help)\n`);
      rl.prompt();
      return;
    }

    try {
      const res = await evalInChild(state, trimmed);
      flushChildOutput(state, output);
      if (res.ok) {
        output.write(formatValue(res.value) + '\n');
      } else {
        output.write(`error: ${res.error}\n`);
      }
    } catch (err) {
      flushChildOutput(state, output);
      output.write(`error: ${err.message}\n`);
      // If child died or was killed (e.g. timeout), try to respawn so REPL
      // stays usable. We wait briefly for the exit event to settle.
      const looksDead = state.exited || /timed out|child exited|child not running/.test(err.message);
      if (looksDead) {
        await new Promise(r => setTimeout(r, 50));
        state = spawnChild(bundlePath);
        try { await state.readyPromise; } catch {}
      }
    }
    rl.prompt();
  });

  return new Promise(resolve => {
    rl.on('close', () => {
      try { state.child.kill(); } catch {}
      resolve(0);
    });
  });
}

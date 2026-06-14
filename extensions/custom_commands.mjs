import { spliceAfter } from '../runner/patch-helpers.mjs';

// The CJS-IIFE wrapper header. The hook is spliced *inside* the wrapper (after
// the opening brace) so it shares scope with the bundle body.
const CJS_IIFE_HEAD = '(function(exports, require, module, __filename, __dirname) {';

export default {
    category: 'infrastructure',

    description: 'Slash command registry primitives + generic commands (/clear-cache, /costs, /export, /stats)',
    capabilities: ["prompt","tools"],
    // Hook references the sentinel 3×: the assignment, the queue-drain call,
    // and the slashCommands contract value (register:).
    verify: { present: '__ccpRegisterSlashCommand', count: { present: 3 } },
    apply: (code) => {
      // Idempotency (rule 2): sentinel == verify.present marker. Re-apply on an
      // already-patched bundle is a byte-identical no-op.
      if (code.includes('__ccpRegisterSlashCommand')) return code;
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Custom Commands — registry + generic commands
// ══════════════════════════════════════════════════════════════════════════

globalThis.__CUSTOM_COMMANDS__ = globalThis.__CUSTOM_COMMANDS__ || {
  '/costs': () => globalThis.__showCosts__?.() || console.log('Cost tracking not enabled'),
  '/clear-cache': async () => {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const roots = [
        path.join(process.env.HOME || '.', '.cc-cache'),
        path.join(process.env.HOME || '.', '.cc/conversations'),
      ];
      for (const root of roots) {
        await fs.rm(root, { recursive: true, force: true });
      }
      console.log('Cache cleared');
    } catch (err) {
      console.log('Cache clear failed:', err?.message || err);
    }
  },
  '/export': async (args) => {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const home = process.env.HOME || '.';
      const convoDir = path.join(home, '.cc/conversations');
      const files = [];
      try {
        for (const entry of await fs.readdir(convoDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(convoDir, entry.name));
        }
      } catch (_) {}
      if (files.length === 0) {
        console.log('No saved conversations found');
        return;
      }
      const target = args && args[0] ? path.resolve(args[0]) : path.join(convoDir, 'export.jsonl');
      let out = '';
      for (const file of files.sort()) {
        out += await fs.readFile(file, 'utf8');
        if (!out.endsWith('\\n')) out += '\\n';
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, out, 'utf8');
      console.log('Exported conversations to', target);
    } catch (err) {
      console.log('Export failed:', err?.message || err);
    }
  },
  '/stats': () => {
    console.log('Session stats:');
    console.log('  PID:', process.pid);
    console.log('  Uptime:', Math.floor(process.uptime()), 'seconds');
    console.log('  Memory:', Math.floor(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');
  },
};

// Register a slash command handler under /name (or name).
// Supports pre-registration: callers that run before this setup (due to
// CJS-IIFE prepend ordering) push into __ccpSlashQueue; we drain it here.
globalThis.__ccpRegisterSlashCommand = (name, handler) => {
  const key = name.startsWith('/') ? name : '/' + name;
  globalThis.__CUSTOM_COMMANDS__[key] = handler;
};
if (globalThis.__ccpSlashQueue) {
  for (const [n, h] of globalThis.__ccpSlashQueue.splice(0)) globalThis.__ccpRegisterSlashCommand(n, h);
}

// Dispatch a slash command. Tier 3 patches may wrap this to inject pre-dispatch
// branches (e.g. engine-failover routing). Returns true if handled, false/Promise otherwise.
globalThis.__ccpDispatchSlash = (input) => {
  return globalThis.__handleCustomCommand__(input);
};

globalThis.__handleCustomCommand__ = (input) => {
  const parts = String(input || '').trim().split(/\\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  if (globalThis.__CUSTOM_COMMANDS__[cmd]) {
    try { globalThis.__CUSTOM_COMMANDS__[cmd](args); } catch (e) { console.warn(e); }
    return true;
  }
  return false;
};

// Register the slash-command registry as a typed contract so consumers
// (Tier 3 routing patches that wrap __ccpDispatchSlash, or external tooling)
// get a loud, actionable error instead of a silent \`undefined\` when this
// producer is disabled. The bare globals above are kept for back-compat.
// Versioned sentinel keeps this idempotent; fail-open so a missing/older
// contract kernel never breaks the CLI.
if (typeof globalThis.__ccpProvide === 'function' && !globalThis.__ccpSlashCommandsProvided_v1) {
  try {
    globalThis.__ccpSlashCommandsProvided_v1 = true;
    globalThis.__ccpProvide('slashCommands', {
      version: 1,
      producer: 'custom_commands',
      shape: ['register', 'dispatch'],
      value: {
        register: globalThis.__ccpRegisterSlashCommand,
        dispatch: globalThis.__ccpDispatchSlash,
      },
    });
  } catch (_) {}
}

`;
      return spliceAfter(code, CJS_IIFE_HEAD, hook);
    }
  };

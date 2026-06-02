// cmd-watch.mjs — `ccpatch watch` handler + makeWatchLoop, extracted from cli.mjs (#1).

import path from 'node:path';

import { loadPatches } from '../loader.mjs';
import { resolveProfile } from '../manifest.mjs';
import { readProfiles, readPatchFlags } from '../config.mjs';
import { resolvePatchNames } from '../runner.mjs';
import { emitOverlay } from '../overlay-builder.mjs';
import { PROJECT_ROOT } from '../paths.mjs';

/**
 * `ccpatch watch <input.js> <output.js>` — run the normal apply flow once
 * with --dev, then watch core/*.mjs and extensions/*.mjs for changes. On any
 * change, re-emit only the overlay loader + shim files (NOT the patched
 * bundle). A debounce window collapses rapid save bursts into a single
 * re-emit.
 *
 * Exposed for testing as `runWatch({ inputPath, outputPath, ..., once, watcher })`.
 * If `opts.once === true`, runs the initial apply and re-emit then returns
 * (no fs.watch). If `opts.watcher` is provided, uses it instead of fs.watch
 * (for test injection).
 */
export async function runWatch(options, logger = console) {
  // Import runPatchCli lazily to avoid a circular dependency (cli.mjs imports
  // this module; this module needs runPatchCli only at call time, not at load time).
  const { runPatchCli } = await import('../cli.mjs');
  const fsmod = await import('node:fs');
  const initial = await runPatchCli([
    options.inputPath,
    options.outputPath,
    ...options.requestedPatches.flatMap(p => ['--patch', p]),
    ...(options.profile ? ['--profile', options.profile] : []),
    '--dev',
  ], logger);
  if (initial !== 0) {
    logger.error('[watch] initial apply failed; not entering watch loop.');
    return initial;
  }

  if (options.once) return 0;

  // Re-resolve patches (same logic as apply) so re-emit picks up edits.
  const reEmit = async (reason) => {
    try {
      const patches = await loadPatches({});
      const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
      let names;
      if (options.profile) {
        const profiles = readProfiles(yamlPath);
        const { enabled } = resolveProfile(options.profile, profiles, Object.keys(patches));
        names = enabled;
      } else if (options.requestedPatches.length > 0) {
        names = resolvePatchNames(patches, options.requestedPatches);
      } else {
        const flags = readPatchFlags(yamlPath);
        names = flags
          ? Object.keys(patches).filter(n => flags[n] === true)
          : Object.keys(patches);
      }
      const emitted = emitOverlay(patches, names, path.dirname(options.outputPath), { dev: true });
      if (emitted) {
        logger.log(`[watch] re-emitted overlay (${reason})`);
      }
    } catch (err) {
      logger.error(`[watch] re-emit failed: ${err.message}`);
    }
  };

  const debounceMs = options.debounceMs ?? 200;
  let timer = null;
  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; reEmit(reason); }, debounceMs);
  };

  const watchDirs = [
    path.join(PROJECT_ROOT, 'core'),
    path.join(PROJECT_ROOT, 'extensions'),
  ];
  const watchers = [];
  for (const dir of watchDirs) {
    if (!fsmod.existsSync(dir)) continue;
    const w = fsmod.watch(dir, { persistent: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.mjs')) return;
      schedule(filename);
    });
    watchers.push(w);
  }
  logger.log(`[watch] watching ${watchDirs.length} directories (debounce=${debounceMs}ms). Ctrl-C to exit.`);

  return await new Promise((resolve) => {
    const cleanup = () => {
      for (const w of watchers) { try { w.close(); } catch (_) {} }
      if (timer) clearTimeout(timer);
      logger.log('\n[watch] exiting.');
      resolve(0);
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  });
}

/**
 * Helper used by tests: given `opts` with patches, names, outputDir, and
 * shimDir (created by an initial emitOverlay({dev:true}) call), spin up a
 * debounced watch loop driven by an injected event source. Returns
 * `{ trigger, drain, getReEmitCount, stop }`.
 *
 * This factors out the debounce + re-emit core from `runWatch` so tests can
 * exercise it without spawning fs.watch.
 */
export function makeWatchLoop({ patches, names, outputDir, debounceMs = 200, logger = console }) {
  let timer = null;
  let reEmits = 0;
  const reEmit = (reason) => {
    reEmits++;
    try {
      emitOverlay(patches, names, outputDir, { dev: true });
      logger.log(`[watch] re-emitted overlay (${reason})`);
    } catch (err) {
      logger.error(`[watch] re-emit failed: ${err.message}`);
    }
  };
  return {
    trigger(reason = 'change') {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reEmit(reason); }, debounceMs);
    },
    async drain() {
      await new Promise(r => setTimeout(r, debounceMs + 50));
    },
    getReEmitCount() { return reEmits; },
    stop() { if (timer) clearTimeout(timer); },
  };
}

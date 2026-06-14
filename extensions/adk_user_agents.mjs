/**
 * adk_user_agents — load USER-authored ADK agents/tools without writing a patch.
 *
 * The ADK is normally only reachable by authoring a build-time `agentDir` patch
 * (see adk_hello_agent). This patch opens a user-facing authoring path: at boot
 * it scans a config directory and loads every `*.mjs` file in it as an ADK
 * module, so end users drop a file in a folder instead of touching the bundle.
 *
 * Config dir (first that exists, both scanned in order; later overrides earlier):
 *   1. $CCPATCH_AGENTS_DIR        (explicit override)
 *   2. ~/.ccpatch/agents/         (default)
 *
 * Each user module is an ESM file exporting either:
 *   - export function register(adk) { ... }   // called with the ADK namespace
 *   - export default function (adk) { ... }    // same, default export
 * Inside, the author calls adk.defineAgent / adk.defineTool / adk.defineHandoff.
 * They should call adk.capabilities() themselves to preflight; this loader also
 * skips loudly when the ADK runtime can't be imported.
 *
 * Like adk_hello_agent this carries NO bundle anchor: apply() is a no-op and all
 * behavior ships in the emitted ccpatch-agents/ file, loaded by core/overlay_loader
 * after the expose_* shims register their __ccp* globals. Failures are isolated
 * per-file and never crash the boot.
 *
 * SECURITY: files in the config dir run with full process privileges inside the
 * CLI — exactly like a patch would. Only the local user can write there
 * (~/.ccpatch is user-owned); the loader does NOT fetch or execute remote code.
 * Treat the config dir as a trust boundary equal to writing a patch.
 */

const AGENT_CODE = `
// ccpatch-agents/adk-user-agents.mjs — generated from extensions/adk_user_agents.mjs.
// Loaded at boot by the core/overlay_loader agents-dir block, AFTER the expose_*
// shims have registered their __ccp* globals.
'use strict';

(async () => {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  // The ADK runtime is copied to <bundle-dir>/ccpatch-adk/ by the build; this
  // file lives in <bundle-dir>/ccpatch-agents/, so the ADK is one dir up.
  let adk;
  try {
    adk = await import(new URL('../ccpatch-adk/index.mjs', import.meta.url).href);
  } catch (e) {
    process.stderr.write('[adk-user] could not import ADK runtime: ' + (e && e.message) + '\\n');
    return;
  }

  // Preflight once so a totally-unwired session skips quietly instead of letting
  // every user module hang on a never-injecting tool.
  let caps;
  try { caps = adk.capabilities(); } catch (e) {
    process.stderr.write('[adk-user] capabilities() threw: ' + (e && e.message) + '\\n');
    return;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '.';
  const dirs = [];
  if (process.env.CCPATCH_AGENTS_DIR) dirs.push(process.env.CCPATCH_AGENTS_DIR);
  dirs.push(path.join(home, '.ccpatch', 'agents'));

  let loaded = 0;
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue; // dir absent → nothing to load from it
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.mjs')) continue;
      const file = path.join(dir, ent.name);
      let mod;
      try {
        mod = await import(pathToFileURL(file).href);
      } catch (e) {
        process.stderr.write('[adk-user] failed to import ' + file + ': ' + (e && e.message) + '\\n');
        continue;
      }
      const register = typeof mod.register === 'function'
        ? mod.register
        : (typeof mod.default === 'function' ? mod.default : null);
      if (!register) {
        process.stderr.write('[adk-user] ' + file + ' exports no register(adk)/default fn — skipped\\n');
        continue;
      }
      try {
        // Pass the ADK namespace plus the preflight result so authors can gate
        // on caps without re-probing.
        await register(adk, caps);
        loaded++;
      } catch (e) {
        process.stderr.write('[adk-user] register() in ' + file + ' threw: ' + (e && e.message) + '\\n');
      }
    }
  }

  if ((process.env.CLAUDE_DEBUG || globalThis.__ccpDebug) && loaded) {
    process.stderr.write('[adk-user] loaded ' + loaded + ' user agent module(s)\\n');
  }
})().catch((e) => {
  try { process.stderr.write('[adk-user] fatal: ' + (e && e.message) + '\\n'); } catch (_) {}
});
`;

export default {
  name: 'adk_user_agents',
  version: '0.1.0',
  category: 'optional',
  description: 'Load user-authored ADK agents/tools from ~/.ccpatch/agents/*.mjs (no patch authoring needed).',
  // User modules inject tools through the ADK → expose_tool_dispatch (tools), and
  // may swap personas → expose_system_prompt (prompt).
  capabilities: ['tools', 'prompt'],
  env: ['CCPATCH_AGENTS_DIR'],
  // The ADK reads these patches' exposed globals/contracts; the runner enforces
  // they are present and ordered before this patch.
  dependsOn: ['expose_tool_dispatch', 'expose_system_prompt'],
  enabled: false,
  // No bundle mutation — apply() is a no-op, so we MUST NOT declare verify.present
  // (the runner would treat the correct no-change as anchor drift; see
  // runner/apply-pipeline.mjs and the same note in adk_hello_agent.mjs). An
  // absent-only verify describes the desired end state and is exempt from the
  // no-change-is-fatal gate. The emitted file's integrity is its .sha256 sidecar.
  verify: { absent: '__ccp_adk_user_agents_should_never_be_in_bundle__' },
  agentDir: {
    name: 'adk-user-agents',
    code: AGENT_CODE,
  },
  apply: (code) => code,
};

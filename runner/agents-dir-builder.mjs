import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const AGENTS_DIR_NAME = 'ccpatch-agents';
const ADK_DIR_NAME = 'ccpatch-adk';

// Source dir of the bundled ADK (packages/adk), resolved relative to this
// builder module so it works regardless of cwd. The runtime files we ship are
// the ESM sources the ADK's package.json `files` list publishes.
const ADK_SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'adk',
);
const ADK_RUNTIME_FILES = [
  'index.mjs',
  'agent.mjs',
  'tool-registry.mjs',
  'handoff.mjs',
  'memory.mjs',
];

/**
 * Collect `agentDir: { name, code }` entries from the enabled patch set, in the
 * order given. Mirrors collectOverlayPatches() in overlay-builder.mjs.
 *
 * @param {object} patches      registry { name -> patch }
 * @param {string[]} patchNames selected patch names
 * @returns {{ name: string, code: string }[]}
 */
export function collectAgentDirPatches(patches, patchNames) {
  const out = [];
  for (const name of patchNames) {
    const patch = patches[name];
    if (!patch || !patch.agentDir) continue;
    const { name: agentName, code } = patch.agentDir;
    if (typeof agentName !== 'string' || !agentName
      || typeof code !== 'string' || !code) continue;
    out.push({ name: agentName, code });
  }
  return out;
}

/**
 * Copy the ADK runtime sources into `<outputDir>/ccpatch-adk/` (with `.sha256`
 * sidecars) so emitted `ccpatch-agents/*.mjs` entries can resolve the ADK from
 * a path next to the patched bundle — no install-layout assumption. Returns the
 * absolute paths of the copied source files (not sidecars), or [] when the ADK
 * source is unavailable.
 *
 * @param {string} outputDir  directory that holds the patched bundle
 * @returns {string[]}
 */
export function emitAdkRuntime(outputDir) {
  if (!fs.existsSync(path.join(ADK_SRC_DIR, 'index.mjs'))) {
    console.warn(`[ccpatch] ADK source not found at ${ADK_SRC_DIR} — skipping ADK copy`);
    return [];
  }
  const adkDir = path.join(outputDir, ADK_DIR_NAME);
  fs.mkdirSync(adkDir, { recursive: true });

  const written = [];
  for (const file of ADK_RUNTIME_FILES) {
    const src = path.join(ADK_SRC_DIR, file);
    if (!fs.existsSync(src)) {
      console.warn(`[ccpatch] ADK runtime file missing: ${file} — skipping`);
      continue;
    }
    const body = fs.readFileSync(src, 'utf8');
    const dst = path.join(adkDir, file);
    fs.writeFileSync(dst, body, 'utf8');
    try {
      const hex = createHash('sha256').update(body, 'utf8').digest('hex');
      fs.writeFileSync(dst + '.sha256', hex + '\n', 'utf8');
    } catch (e) {
      console.warn(`[ccpatch] ADK sidecar write failed for "${file}":`, e && e.message);
    }
    written.push(dst);
  }
  return written;
}

/**
 * Write each agent definition as a standalone `.mjs` file (plus a `.sha256`
 * sidecar) into `<outputDir>/ccpatch-agents/`. Returns the list of written
 * paths (agent files only, not sidecars).
 *
 * @param {{ name: string, code: string }[]} agents
 * @param {string} outputDir  directory that holds the patched bundle
 * @returns {string[]}        absolute paths of written agent files
 */
export function emitAgentsDir(agents, outputDir) {
  if (!Array.isArray(agents) || agents.length === 0) return [];

  const agentsDir = path.join(outputDir, AGENTS_DIR_NAME);
  fs.mkdirSync(agentsDir, { recursive: true });

  const written = [];
  for (const { name, code } of agents) {
    if (typeof name !== 'string' || !name || typeof code !== 'string') continue;
    const agentPath = path.join(agentsDir, `${name}.mjs`);
    fs.writeFileSync(agentPath, code, 'utf8');
    try {
      const hex = createHash('sha256').update(code, 'utf8').digest('hex');
      fs.writeFileSync(agentPath + '.sha256', hex + '\n', 'utf8');
    } catch (e) {
      console.warn(`[ccpatch] agents-dir sidecar write failed for "${name}":`, e && e.message);
    }
    written.push(agentPath);
  }
  return written;
}

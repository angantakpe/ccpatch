import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const AGENTS_DIR_NAME = 'ccpatch-agents';

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

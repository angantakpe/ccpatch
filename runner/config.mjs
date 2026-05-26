import { existsSync, readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';

/**
 * Parse ccpatch.yml and return a name → boolean map.
 *
 * Shorthand:  name: true / false
 * Long-form:  name: { enabled: true/false, env: [...], ... }
 *
 * Returns null if the file doesn't exist (caller falls back to "apply all").
 */
export function readPatchFlags(yamlPath) {
  if (!existsSync(yamlPath)) return null;

  const doc = yamlLoad(readFileSync(yamlPath, 'utf8'));
  if (!doc?.patches || typeof doc.patches !== 'object') return null;

  const flags = {};
  for (const [name, val] of Object.entries(doc.patches)) {
    if (typeof val === 'boolean') {
      flags[name] = val;
    } else if (val && typeof val === 'object') {
      flags[name] = val.enabled !== false;
    }
  }
  return flags;
}

/**
 * Parse the optional `ack:` map from ccpatch.yml. Each entry acknowledges
 * the capabilities required by a patch, signalling the user has read
 * THREAT_MODEL.md for that patch.
 *
 *   ack:
 *     fetch_interceptor: [network]
 *     bun_shim: [env, network]
 *
 * Returns { [patchName]: string[] } or null if absent/unreadable.
 */
export function readAcks(yamlPath) {
  if (!existsSync(yamlPath)) return null;
  const doc = yamlLoad(readFileSync(yamlPath, 'utf8'));
  if (!doc?.ack || typeof doc.ack !== 'object') return null;
  const out = {};
  for (const [name, val] of Object.entries(doc.ack)) {
    if (Array.isArray(val)) {
      out[name] = val.filter(s => typeof s === 'string');
    } else if (val === true) {
      out[name] = ['*'];
    }
  }
  return out;
}

/**
 * Parse the optional `profiles:` map from ccpatch.yml.
 * Returns { name: string[] } or null if absent/unreadable.
 */
export function readProfiles(yamlPath) {
  if (!existsSync(yamlPath)) return null;
  const doc = yamlLoad(readFileSync(yamlPath, 'utf8'));
  if (!doc?.profiles || typeof doc.profiles !== 'object') return null;
  const out = {};
  for (const [name, val] of Object.entries(doc.profiles)) {
    if (Array.isArray(val)) out[name] = val.filter(s => typeof s === 'string');
  }
  return out;
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Render a YAML inline-array value for an ack entry, e.g. ['env','network']
 * → "[env, network]". Caps are emitted bare (no quotes) since capability
 * names are simple identifiers; `*` is preserved verbatim.
 */
function renderAckCaps(caps) {
  return '[' + caps.join(', ') + ']';
}

/**
 * Write (or update) a single `ack:` entry in ccpatch.yml using a targeted
 * text edit so the file's comment block is preserved (a full js-yaml dump
 * would drop every comment).
 *
 * Behavior:
 *   - If the file is missing, it is created with a minimal `version: 1` +
 *     `ack:` block.
 *   - If an `ack:` block exists and already lists `<patchName>`, that line is
 *     rewritten in place with the merged capability set.
 *   - If an `ack:` block exists without `<patchName>`, a new line is inserted
 *     at the end of the block (before the first non-ack line).
 *   - If no `ack:` block exists, one is inserted just before `patches:` (or at
 *     end of file if there's no patches block).
 *
 * `caps` are merged with any existing acked caps for that patch (union,
 * order-stable: existing first, then new). Returns
 * { wrote: boolean, caps: string[], created: boolean } where `caps` is the
 * final merged set written for the patch.
 */
export function writeAck(yamlPath, patchName, caps) {
  const newCaps = Array.isArray(caps) ? caps.filter(c => typeof c === 'string') : [];

  // Merge with any caps already acknowledged for this patch.
  const existing = readAcks(yamlPath) || {};
  const prior = Array.isArray(existing[patchName]) ? existing[patchName] : [];
  const merged = [...prior];
  for (const c of newCaps) if (!merged.includes(c)) merged.push(c);
  const rendered = `  ${patchName}: ${renderAckCaps(merged)}`;

  if (!existsSync(yamlPath)) {
    const body = `version: 1\nack:\n${rendered}\n`;
    writeFileSync(yamlPath, body);
    return { wrote: true, caps: merged, created: true };
  }

  const src = readFileSync(yamlPath, 'utf8');
  const lines = src.split('\n');

  // Locate the `ack:` block (a top-level key with no leading whitespace).
  const ackIdx = lines.findIndex(l => /^ack:\s*(#.*)?$/.test(l));

  const entryRe = new RegExp(`^\\s+${escapeKey(patchName)}:\\s`);

  if (ackIdx !== -1) {
    // Scan the indented body of the ack block.
    let end = ackIdx + 1;
    let entryLineIdx = -1;
    for (; end < lines.length; end++) {
      const l = lines[end];
      if (l.trim() === '' || l.startsWith('#')) continue;        // blanks/comments stay in-block
      if (/^\s/.test(l)) {
        if (entryRe.test(l)) entryLineIdx = end;
        continue;                                                 // still inside the block
      }
      break;                                                      // first non-indented line ends the block
    }
    if (entryLineIdx !== -1) {
      lines[entryLineIdx] = rendered;                             // rewrite in place
    } else {
      // Insert before the first trailing blank/comment lines of the block so
      // the new entry sits with the other entries.
      let insertAt = end;
      while (insertAt - 1 > ackIdx && lines[insertAt - 1].trim() === '') insertAt--;
      lines.splice(insertAt, 0, rendered);
    }
    writeFileSync(yamlPath, lines.join('\n'));
    return { wrote: true, caps: merged, created: false };
  }

  // No ack block: insert one before `patches:` (or append to EOF).
  const patchesIdx = lines.findIndex(l => /^patches:\s*(#.*)?$/.test(l));
  const block = ['ack:', rendered, ''];
  if (patchesIdx !== -1) {
    lines.splice(patchesIdx, 0, ...block);
  } else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push('ack:', rendered, '');
  }
  writeFileSync(yamlPath, lines.join('\n'));
  return { wrote: true, caps: merged, created: false };
}

function escapeKey(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

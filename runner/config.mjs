import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';

import { resolveProfile } from './manifest.mjs';
import { resolvePatchNames } from './runner.mjs';
import { applyNativeProfileFilter } from './cli/native-profile.mjs';

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

/**
 * U2: single source of truth for "which patches end up selected, and why".
 *
 * Config has several overlapping selection mechanisms whose precedence used to
 * live inline in runBuild only:
 *   1. Explicit --patch list (bypasses ccpatch.yml entirely).
 *   2. --profile (uses the profiles: map, ignores per-patch enabled flags).
 *   3. ccpatch.yml per-patch enabled flags (yaml mode: no --patch / --patch all).
 *   4. Auto-inclusion of `required: true` patches when an explicit list is used.
 *   5. --profile=native auto-exclusion of esm_compat / bun_shim.
 *
 * This function reproduces that precedence exactly so BOTH `runBuild` and
 * `ccpatch explain` call it and can't drift. It is pure: it reads ccpatch.yml
 * only via the supplied `yamlPath` and returns its findings rather than logging.
 *
 * @param {object} args
 * @param {Record<string, object>} args.patches  loaded patch registry
 * @param {string[]} args.requested              options.requestedPatches (--patch values)
 * @param {string|null} args.profile             --profile value (null when unset)
 * @param {string} args.yamlPath                 absolute path to ccpatch.yml
 * @returns {{
 *   selected: string[],
 *   reasons: Record<string, string>,
 *   notices: string[],
 *   yamlMode: boolean,
 * }}
 *   `selected` is the final ordered list to apply. `reasons[name]` explains why
 *   EVERY known patch is in or out. `notices` are the human-readable log lines
 *   runBuild historically printed (so it can emit them verbatim). `yamlMode`
 *   indicates whether ccpatch.yml flags drove selection.
 */
export function resolveEffectivePatches({ patches, requested, profile, yamlPath }) {
  const allNames = Object.keys(patches);
  const reasons = {};
  const notices = [];

  const requestedPatches = Array.isArray(requested) ? requested : [];
  const isYamlMode = requestedPatches.length === 0
    || (requestedPatches.length === 1 && requestedPatches[0] === 'all');

  let effectiveRequested = requestedPatches;

  if (isYamlMode) {
    if (profile) {
      const profiles = readProfiles(yamlPath);
      const { enabled, unknown } = resolveProfile(profile, profiles, allNames);
      if (unknown.length > 0) {
        notices.push(`  [config] profile "${profile}": ${unknown.length} unknown patch name(s) skipped: ${unknown.join(', ')}`);
      }
      notices.push(`[ccpatch] profile=${profile} patches=${enabled.length}`);
      const enabledSet = new Set(enabled);
      for (const name of allNames) {
        reasons[name] = enabledSet.has(name)
          ? `in: profile=${profile}`
          : `out: not in profile ${profile}`;
      }
      effectiveRequested = enabled;
    } else {
      const yamlFlags = readPatchFlags(yamlPath);
      if (yamlFlags) {
        const unlisted = allNames.filter(name => !(name in yamlFlags));
        if (unlisted.length > 0) {
          notices.push(`  [config] ccpatch.yml: ${unlisted.length} unlisted patch(es) skipped (add to ccpatch.yml to enable): ${unlisted.join(', ')}`);
        }
        const enabled = allNames.filter(name => yamlFlags[name] === true);
        const disabled = allNames.filter(name => name in yamlFlags && yamlFlags[name] !== true);
        if (disabled.length > 0) {
          notices.push(`  [config] ccpatch.yml: ${enabled.length} enabled, ${disabled.length} disabled (${disabled.join(', ')})`);
        }
        for (const name of allNames) {
          if (yamlFlags[name] === true) reasons[name] = 'in: enabled in ccpatch.yml';
          else if (name in yamlFlags) reasons[name] = 'out: disabled in ccpatch.yml';
          else reasons[name] = 'out: unlisted in ccpatch.yml';
        }
        effectiveRequested = enabled;
      } else {
        // No ccpatch.yml flags block: apply everything.
        for (const name of allNames) reasons[name] = 'in: no ccpatch.yml — applying all';
        effectiveRequested = ['all'];
      }
    }
  } else {
    // Explicit --patch list bypasses ccpatch.yml entirely.
    const requestedSet = new Set(effectiveRequested);
    for (const name of allNames) {
      reasons[name] = requestedSet.has(name)
        ? 'in: requested via --patch'
        : 'out: not in --patch list';
    }
  }

  let patchesToApply = resolvePatchNames(patches, effectiveRequested);

  // Explicit list (not yaml-mode, not "all"): auto-include `required: true`
  // patches so picking a single extension doesn't drop infra patches.
  if (!isYamlMode && !effectiveRequested.includes('all')) {
    const selectedSet = new Set(patchesToApply);
    const autoAdded = [];
    for (const [name, patch] of Object.entries(patches)) {
      if (patch && patch.required === true && !selectedSet.has(name)) {
        selectedSet.add(name);
        autoAdded.push(name);
        reasons[name] = 'in: required infra';
      }
    }
    if (autoAdded.length > 0) {
      notices.push(`  [config] auto-including ${autoAdded.length} required patch(es): ${autoAdded.join(', ')}`);
      patchesToApply = [...selectedSet];
    }
  }

  // --profile=native: drop esm_compat / bun_shim (incompatible with Bun SEA).
  {
    const { patches: filtered, excluded } = applyNativeProfileFilter(patchesToApply, profile);
    if (excluded.length > 0) {
      notices.push(`  [native] auto-excluded ${excluded.join(', ')} — incompatible with Bun SEA repack`);
      for (const name of excluded) reasons[name] = 'excluded: native-incompatible';
      patchesToApply = filtered;
    }
  }

  return { selected: patchesToApply, reasons, notices, yamlMode: isYamlMode };
}

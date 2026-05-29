// A1: `ccpatch module <subcommand>` — third-party patch module management,
// split out of cli.mjs. See docs/authoring-patches.md "Third-party patch modules".

import path from 'node:path';

import { PROJECT_ROOT } from '../paths.mjs';
import { parseAllowCapabilities } from './capabilities.mjs';
import {
  installModuleFromPath,
  listModules,
  removeModule,
  verifyModule,
  resolveModuleDir,
  inspectModuleCapabilities,
  readModuleManifest,
  hashPatchesTree,
  resolveContentHash,
  fetchJson,
  fetchAndExtractTarball,
  modulesRoot,
} from '../modules.mjs';

const MODULE_USAGE =
  'Usage:\n' +
  '  ccpatch module install <path-or-url> [--strict] [--allow-capabilities <list>] [--force]\n' +
  '                                       [--insecure] [--expect-sha256 <hex>]\n' +
  '  ccpatch module list\n' +
  '  ccpatch module remove <name>\n' +
  '  ccpatch module verify <name>\n' +
  '  ccpatch module update <name> [--insecure]\n';

export async function runModuleCommand(args, logger = console, opts = {}) {
  // Modules live under <ccpatch-root>/modules/ so the loader (which is rooted
  // at the ccpatch installation) can find them. Tests can override.
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const sub = args[0];
  if (!sub) { logger.log(MODULE_USAGE); return 1; }

  if (sub === 'install') {
    return await moduleInstall(args.slice(1), logger, projectRoot);
  }
  if (sub === 'list') {
    return moduleList(logger, projectRoot);
  }
  if (sub === 'remove' || sub === 'uninstall') {
    return moduleRemove(args.slice(1), logger, projectRoot);
  }
  if (sub === 'verify') {
    return moduleVerify(args.slice(1), logger, projectRoot);
  }
  if (sub === 'update') {
    return await moduleUpdate(args.slice(1), logger, projectRoot);
  }
  logger.log(MODULE_USAGE);
  return 1;
}

async function moduleInstall(args, logger, projectRoot) {
  let src = null;
  let strict = false;
  let force = false;
  let allowRaw = null;
  let insecure = false;          // S2: gate http:// fetches
  let expectSha256 = null;       // S1: out-of-band hash for URL installs
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict') strict = true;
    else if (a === '--force') force = true;
    else if (a === '--insecure') insecure = true;
    else if (a === '--allow-capabilities' && args[i + 1]) allowRaw = args[++i];
    else if (a.startsWith('--allow-capabilities=')) allowRaw = a.slice('--allow-capabilities='.length);
    else if (a === '--expect-sha256' && args[i + 1]) expectSha256 = args[++i];
    else if (a.startsWith('--expect-sha256=')) expectSha256 = a.slice('--expect-sha256='.length);
    else if (!a.startsWith('--') && !src) src = a;
  }
  if (!src) {
    logger.error('Error: module install requires a path or URL.\n' + MODULE_USAGE);
    return 1;
  }
  if (expectSha256 !== null) {
    expectSha256 = expectSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectSha256)) {
      logger.error('Error: --expect-sha256 must be a 64-char hex sha256 digest.');
      return 1;
    }
  }
  if (!strict && process.env.CCPATCH_STRICT === '1') strict = true;

  // Determine source kind.
  let sourceDir;
  let tmpRoot = null;
  const isUrlInstall = /^https?:\/\//i.test(src);
  if (/^git(\+|:)/.test(src) || src.endsWith('.git')) {
    logger.error('Error: git URLs are not supported in v1. Clone manually then `ccpatch module install <local-path>`, or publish a tarball.');
    return 1;
  } else if (isUrlInstall) {
    try {
      sourceDir = await fetchAndExtractTarball(src, { insecure });
      tmpRoot = sourceDir;
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      return 1;
    }
  } else {
    sourceDir = require_path_resolve(src);
  }

  // Pre-install inspection: capability disclosure + signature check.
  let manifest;
  try {
    manifest = readModuleManifest(sourceDir);
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }

  let inspection;
  try {
    inspection = await inspectModuleCapabilities(sourceDir);
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }

  logger.log(`[module] ${manifest.name}@${manifest.version}`);
  logger.log(`  patches: ${inspection.patches.length}`);
  for (const p of inspection.patches) {
    const caps = p.capabilities.length ? p.capabilities.join(',') : '-';
    logger.log(`    ${p.stem.padEnd(28)}  caps=${caps}  risk=${p.risk}`);
  }

  // S1: content-hash check (pre-install). The hash is an INTEGRITY check, not
  // authentication — it ships in the same tree, so a tamperer can recompute it.
  // Accept the modern contentHash field or the deprecated signature alias.
  let inBandHash;
  try {
    inBandHash = resolveContentHash(manifest);
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
  const sourceHash = hashPatchesTree(require_path_join(sourceDir, 'patches'));

  // S1: an out-of-band --expect-sha256 (or an updateChannel-pinned hash) is the
  // ONLY hash that proves anything for a URL install. Verify it against the
  // actual tree first.
  if (expectSha256) {
    if (sourceHash !== expectSha256) {
      logger.error(`Error: --expect-sha256 mismatch — expected ${expectSha256.slice(0, 16)}…, computed ${sourceHash.slice(0, 16)}…. Refusing to install.`);
      return 1;
    }
    logger.log(`  contentHash OK (verified against out-of-band --expect-sha256 — integrity AND source pinned).`);
  }

  if (inBandHash.hash) {
    if (sourceHash !== inBandHash.hash) {
      logger.error(`Error: contentHash mismatch — manifest declares ${inBandHash.hash.slice(0, 16)}…, computed ${sourceHash.slice(0, 16)}…. Refusing to install.`);
      return 1;
    }
    if (inBandHash.source === 'signature') {
      logger.log(`  note: manifest uses the deprecated "signature" field — rename it to "contentHash".`);
    }
    if (!expectSha256 && isUrlInstall) {
      // S1: a hash baked into the same download proves nothing about the source.
      logger.log(`  contentHash OK (integrity only — not authenticity). WARNING: unverified source — the hash came from the same download. Pass --expect-sha256 <hex> obtained out-of-band to pin the source.`);
    } else if (!expectSha256) {
      logger.log(`  contentHash OK (integrity only — not authenticity).`);
    }
  } else if (!expectSha256) {
    logger.log(`  contentHash: NONE — patches/ has no integrity hash, and a self-hash would not prove authorship anyway. Inspect the code before enabling.`);
  }

  // Capability gate.
  const highRisk = inspection.patches.filter(p => p.risk === 'high');
  if (highRisk.length > 0) {
    const allow = parseAllowCapabilities(allowRaw);
    if (allow && allow.unknown.length > 0) {
      logger.error(`Error: --allow-capabilities contains unknown value(s): ${allow.unknown.join(', ')}.`);
      return 1;
    }
    const missing = [];
    for (const p of highRisk) {
      if (allow && allow.all) continue;
      const allowSet = allow ? allow.set : new Set();
      const lacks = p.capabilities.filter(c => !allowSet.has(c));
      if (lacks.length > 0) missing.push({ name: p.name, caps: p.capabilities, lacks });
    }
    if (missing.length > 0) {
      const summary = missing
        .map(m => `  ${m.name.padEnd(36)} caps=${m.caps.join(',')}  missing=${m.lacks.join(',')}`)
        .join('\n');
      if (strict) {
        logger.error(`Error: high-risk patches require --allow-capabilities under --strict:\n${summary}`);
        return 1;
      } else {
        logger.log(`  [capabilities] WARN: high-risk patches not acknowledged (non-strict, proceeding):\n${summary}`);
      }
    }
  }

  let result;
  try {
    result = installModuleFromPath(sourceDir, { projectRoot, force });
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  } finally {
    if (tmpRoot) {
      try { (await import('node:fs')).rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  }

  if (result.signed) {
    if (result.verifyOk) {
      logger.log(`Installed ${result.manifest.name}@${result.manifest.version} → ${result.dir} (contentHash OK — integrity only, not authenticity)`);
      return 0;
    } else {
      logger.error(`Error: post-install contentHash verification failed at ${result.dir}.`);
      return 1;
    }
  }
  logger.log(`Installed ${result.manifest.name}@${result.manifest.version} → ${result.dir}`);
  logger.log(`  WARN: this module has no contentHash. Audit ${result.dir}/patches/ before enabling.`);
  return 0;
}

function moduleList(logger, projectRoot) {
  const mods = listModules(projectRoot);
  if (mods.length === 0) {
    logger.log(`No modules installed under ${modulesRoot(projectRoot)}.`);
    return 0;
  }
  const nameW = Math.max(20, ...mods.map(m => m.name.length));
  // S1: column reflects presence of a contentHash (integrity), not authenticity.
  logger.log(`${'Name'.padEnd(nameW)}  Version    Hashed  Path`);
  for (const m of mods) {
    logger.log(`${m.name.padEnd(nameW)}  ${m.version.padEnd(9)}  ${m.signed ? 'yes' : 'no '}     ${m.dir}`);
  }
  return 0;
}

function moduleRemove(args, logger, projectRoot) {
  const name = args[0];
  if (!name) { logger.error('Error: module remove <name>'); return 1; }
  try {
    const r = removeModule(name, { projectRoot });
    logger.log(`Removed ${name} (${r.removed})`);
    return 0;
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
}

function moduleVerify(args, logger, projectRoot) {
  const name = args[0];
  if (!name) { logger.error('Error: module verify <name>'); return 1; }
  let r;
  try {
    r = verifyModule(name, { projectRoot });
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
  if (!r.signed) {
    logger.log(`${r.name}: NO CONTENT HASH`);
    logger.log(`  patches/ sha256: ${r.actual}`);
    logger.log(`  no contentHash in manifest — nothing to verify against (integrity check only; a self-hash would not prove authorship).`);
    return 0;
  }
  if (r.ok) {
    if (r.hashSource === 'signature') {
      logger.log(`  note: manifest uses the deprecated "signature" field — rename it to "contentHash".`);
    }
    logger.log(`${r.name}: OK (sha256 ${r.actual.slice(0, 16)}… matches manifest contentHash — integrity only, not authenticity)`);
    return 0;
  }
  logger.error(`${r.name}: TAMPERED (patches/ do not match the recorded contentHash)`);
  logger.error(`  expected: ${r.expected}`);
  logger.error(`  actual:   ${r.actual}`);
  return 1;
}

async function moduleUpdate(args, logger, projectRoot) {
  const name = args.find(a => !a.startsWith('--'));
  const insecure = args.includes('--insecure');  // S2: gate http:// fetches
  if (!name) { logger.error('Error: module update <name>'); return 1; }
  let dir;
  try { dir = resolveModuleDir(name, projectRoot); }
  catch (err) { logger.error(`Error: ${err.message}`); return 1; }
  const manifest = readModuleManifest(dir);
  if (!manifest.updateChannel) {
    logger.error(`Error: ${manifest.name} has no updateChannel — cannot update.`);
    return 1;
  }
  let channel;
  try {
    channel = await fetchJson(manifest.updateChannel, { insecure });
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
  if (!channel || typeof channel !== 'object'
      || typeof channel.version !== 'string'
      || typeof channel.url !== 'string') {
    logger.error(`Error: updateChannel ${manifest.updateChannel} did not return { version, url, contentHash? }`);
    return 1;
  }
  if (semverCompare(channel.version, manifest.version) <= 0) {
    logger.log(`${manifest.name} is up to date (${manifest.version} >= ${channel.version}).`);
    return 0;
  }
  logger.log(`[module] update available: ${manifest.version} → ${channel.version}`);
  let sourceDir;
  try {
    sourceDir = await fetchAndExtractTarball(channel.url, { insecure });
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
  // S1: A hash supplied by the updateChannel JSON (fetched separately from the
  // tarball) IS an out-of-band hash — it pins the source, not just integrity.
  // Accept channel.contentHash or the deprecated channel.signature alias.
  const channelHash = (typeof channel.contentHash === 'string' && channel.contentHash.length > 0)
    ? channel.contentHash
    : (typeof channel.signature === 'string' && channel.signature.length > 0 ? channel.signature : null);
  if (channelHash) {
    const fetched = readModuleManifest(sourceDir);
    const sourceHash = hashPatchesTree(require_path_join(sourceDir, 'patches'));
    if (sourceHash !== channelHash) {
      logger.error(`Error: channel contentHash mismatch — channel=${channelHash.slice(0, 16)}…, computed=${sourceHash.slice(0, 16)}…`);
      return 1;
    }
    // Force the update path to record the channel's hash as the canonical
    // contentHash even if the fetched manifest disagrees or uses the alias.
    if (fetched.contentHash !== channelHash) {
      fetched.contentHash = channelHash;
      delete fetched.signature;
      (await import('node:fs')).writeFileSync(
        require_path_join(sourceDir, 'ccpatch-module.json'),
        JSON.stringify(fetched, null, 2),
        'utf8',
      );
    }
  }
  try {
    const result = installModuleFromPath(sourceDir, { projectRoot, force: true });
    logger.log(`Updated ${result.manifest.name} → ${result.manifest.version} at ${result.dir}`);
    return 0;
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  } finally {
    try { (await import('node:fs')).rmSync(sourceDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Small helpers used by the module subcommands. Inlined to avoid scattering
// path imports near the bottom of the file.
function require_path_resolve(p) {
  return path.resolve(p);
}
function require_path_join(...parts) {
  return path.join(...parts);
}

// Naïve "X.Y.Z" comparator. Sufficient for the simple update-channel check;
// not a full semver parser.
function semverCompare(a, b) {
  const A = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const B = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { loadPatches } from './loader.mjs';
import { applyNamedPatches, resolvePatchNames } from './runner.mjs';
import { readPatchFlags, readProfiles } from './config.mjs';
import { resolveProfile, classifyRisk, CAPABILITIES } from './manifest.mjs';
import { probeAnchor, fuzzyMatch } from './anchors.mjs';
import { compileKind } from './patch-kinds.mjs';
import { buildPreload } from './preload-builder.mjs';
import { emitOverlay } from './overlay-builder.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import {
  enumeratePatchNames,
  scanVariantDir,
  pickBestVariant,
} from './version-resolver.mjs';
import {
  installModuleFromPath,
  listModules,
  removeModule,
  verifyModule,
  resolveModuleDir,
  inspectModuleCapabilities,
  readModuleManifest,
  hashPatchesTree,
  fetchJson,
  fetchAndExtractTarball,
  modulesRoot,
} from './modules.mjs';

const REVERT_SIDECAR_VERSION = 1;

const USAGE = 'Usage:\n' +
  '  node patch-cli.mjs <input.js> <output.js> [--patch <name>] [--profile <name>] [--preload <preload.mjs>] [--strict] [--dry-run] [--write-on-clean] [--allow-capabilities <list>] [--dev]\n' +
  '  node patch-cli.mjs watch <input.js> <output.js> [--patch <name>] [--profile <name>] [--debounce <ms>]\n' +
  '  node patch-cli.mjs doctor <input.js> [--profile <name>] [--strict]\n' +
  '  node patch-cli.mjs revert <patched.js> [--output <restored.js>]\n' +
  '  node patch-cli.mjs diff <patched.js>\n' +
  '  node patch-cli.mjs repl <patched.js>\n' +
  '  node patch-cli.mjs versions [--target-version <x.y.z>]\n' +
  '  node patch-cli.mjs capabilities [--profile <name>] [--json]\n' +
  '  node patch-cli.mjs refmap <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]\n' +
  '  node patch-cli.mjs fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]\n' +
  '  node patch-cli.mjs coverage <patched.js> [--smoke <cmd>] [--out <report.json>] [--cc-version X.Y.Z]\n' +
  '  node patch-cli.mjs module install <path-or-url> [--strict] [--allow-capabilities <list>] [--force]\n' +
  '  node patch-cli.mjs module list\n' +
  '  node patch-cli.mjs module remove <name>\n' +
  '  node patch-cli.mjs module verify <name>\n' +
  '  node patch-cli.mjs module update <name>\n' +
  '  node patch-cli.mjs --list\n' +
  '\n' +
  'Profiles (from ccpatch.yml): minimal | standard | power\n' +
  '\n' +
  'revert/diff: reads the <patched>.ccp-revert.json sidecar produced at apply\n' +
  '             time. Only the JS bundle (.mjs/.js) is supported in v1 — Bun\n' +
  '             binary repack reversal is out of scope.';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function sidecarPathFor(outputPath) {
  return outputPath + '.ccp-revert.json';
}

/**
 * Parse --allow-capabilities argument. Accepts `all`, empty (none), or a
 * comma-separated list of capability names. Returns:
 *   { all: boolean, set: Set<string>, unknown: string[] }
 */
export function parseAllowCapabilities(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === '' || trimmed === 'none') return { all: false, set: new Set(), unknown: [] };
  if (trimmed === 'all') return { all: true, set: new Set(CAPABILITIES), unknown: [] };
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  const set = new Set();
  const unknown = [];
  for (const p of parts) {
    if (CAPABILITIES.includes(p)) set.add(p);
    else unknown.push(p);
  }
  return { all: false, set, unknown };
}

/**
 * Given the patches selected for apply and the allow list, return list of
 * { name, capabilities, risk, missing } describing high-risk patches whose
 * capabilities are NOT all permitted by the allow list.
 */
export function findGateViolations(patches, names, allow) {
  const violations = [];
  for (const name of names) {
    const p = patches[name];
    if (!p) continue;
    const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
    const risk = classifyRisk(caps);
    if (risk !== 'high') continue;
    if (allow && allow.all) continue;
    const allowSet = allow ? allow.set : new Set();
    const missing = caps.filter(c => !allowSet.has(c));
    if (missing.length > 0) {
      violations.push({ name, capabilities: caps, risk, missing });
    }
  }
  return violations;
}

export function parsePatchCliArgs(args) {
  if (args.includes('--list')) {
    return { list: true };
  }
  if (args[0] === 'revert') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs revert <patched.js> [--output <restored.js>]' };
    }
    const patchedPath = path.resolve(rest[0]);
    let outputPath = null;
    for (let i = 1; i < rest.length; i++) {
      if ((rest[i] === '--output' || rest[i] === '-o') && rest[i + 1]) outputPath = path.resolve(rest[++i]);
    }
    return { revert: true, patchedPath, outputPath };
  }
  if (args[0] === 'diff') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs diff <patched.js>' };
    }
    return { diff: true, patchedPath: path.resolve(rest[0]) };
  }
  if (args[0] === 'repl') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs repl <patched.js>' };
    }
    return { repl: true, patchedPath: path.resolve(rest[0]) };
  }
  if (args[0] === 'versions') {
    const rest = args.slice(1);
    let targetVersion = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--target-version' && rest[i + 1]) targetVersion = rest[++i];
    }
    if (!targetVersion && process.env.CCPATCH_CLI_VERSION) {
      targetVersion = process.env.CCPATCH_CLI_VERSION;
    }
    return { versions: true, targetVersion };
  }
  if (args[0] === 'capabilities') {
    const rest = args.slice(1);
    let profile = null;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
      else if (rest[i] === '--json') json = true;
    }
    return { capabilities: true, profile, json };
  }
  if (args[0] === 'refmap') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs refmap <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]' };
    }
    const bundlePath = path.resolve(rest[0]);
    let outPath = null;
    let ccVersion = null;
    let check = false;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--out' && rest[i + 1]) outPath = path.resolve(rest[++i]);
      else if (rest[i] === '--cc-version' && rest[i + 1]) ccVersion = rest[++i];
      else if (rest[i] === '--check') check = true;
    }
    if (!ccVersion && process.env.CCPATCH_CLI_VERSION) ccVersion = process.env.CCPATCH_CLI_VERSION;
    return { refmap: true, bundlePath, outPath, ccVersion, check };
  }
  if (args[0] === 'fallback-capture') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs fallback-capture <patched.js> --against <unpatched.js> --patch <name>' };
    }
    const patchedPath = path.resolve(rest[0]);
    let againstPath = null;
    let patchName = null;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--against' && rest[i + 1]) againstPath = path.resolve(rest[++i]);
      else if (rest[i] === '--patch' && rest[i + 1]) patchName = rest[++i];
    }
    if (!againstPath) {
      return { error: 'fallback-capture: --against <unpatched.js> is required' };
    }
    return { fallbackCapture: true, patchedPath, againstPath, patchName };
  }
  if (args[0] === 'watch') {
    const rest = args.slice(1);
    if (rest.length < 2) {
      return { error: 'Usage: node patch-cli.mjs watch <input.js> <output.js> [--patch <name>] [--profile <name>] [--debounce <ms>]' };
    }
    const inputPath = path.resolve(rest[0]);
    const outputPath = path.resolve(rest[1]);
    let profile = null;
    let debounceMs = 200;
    const requestedPatches = [];
    for (let i = 2; i < rest.length; i++) {
      if (rest[i] === '--patch' && rest[i + 1]) requestedPatches.push(rest[++i]);
      else if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
      else if (rest[i] === '--debounce' && rest[i + 1]) debounceMs = parseInt(rest[++i], 10) || 200;
    }
    return { watch: true, inputPath, outputPath, requestedPatches, profile, debounceMs };
  }
  if (args[0] === 'coverage') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs coverage <patched-bundle> [--smoke <cmd>] [--out <report.json>] [--cc-version X.Y.Z]' };
    }
    const bundlePath = path.resolve(rest[0]);
    let smoke = null;
    let outPath = null;
    let ccVersion = null;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--smoke' && rest[i + 1]) smoke = rest[++i];
      else if (rest[i] === '--out' && rest[i + 1]) outPath = path.resolve(rest[++i]);
      else if (rest[i] === '--cc-version' && rest[i + 1]) ccVersion = rest[++i];
    }
    if (!ccVersion && process.env.CCPATCH_CLI_VERSION) ccVersion = process.env.CCPATCH_CLI_VERSION;
    return { coverage: true, bundlePath, smoke, outPath, ccVersion };
  }
  if (args[0] === 'doctor') {
    const rest = args.slice(1);
    if (rest.length < 1) {
      return { error: 'Usage: node patch-cli.mjs doctor <input.js> [--profile <name>] [--strict]' };
    }
    const inputPath = path.resolve(rest[0]);
    let profile = null;
    let strict = false;
    for (let i = 1; i < rest.length; i++) {
      if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
      else if (rest[i] === '--strict') strict = true;
    }
    if (!strict && process.env.CCPATCH_STRICT === '1') strict = true;
    return { doctor: true, inputPath, profile, strict };
  }
  if (args.length < 2) {
    return { error: USAGE };
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = path.resolve(args[1]);
  const requestedPatches = [];
  let preloadPath = null;
  let profile = null;

  const patchOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patch' && args[i + 1]) {
      requestedPatches.push(args[i + 1]);
    }
    if ((args[i] === '--profile' || args[i] === '-p') && args[i + 1]) {
      profile = args[i + 1];
    }
    if ((args[i] === '--model' || args[i] === '--version') && args[i + 1]) {
      patchOptions[args[i].slice(2)] = args[i + 1];
    }
    if (args[i] === '--preload' && args[i + 1]) {
      preloadPath = path.resolve(args[i + 1]);
    }
    if (args[i] === '--strict') {
      patchOptions.strict = true;
    }
    if (args[i] === '--dry-run') {
      patchOptions.dryRun = true;
    }
    if (args[i] === '--write-on-clean') {
      patchOptions.writeOnClean = true;
    }
    if (args[i] === '--no-fallback') {
      patchOptions.disableFallback = true;
    }
    if (args[i] === '--dev') {
      patchOptions.dev = true;
    }
    if (args[i] === '--allow-capabilities' && args[i + 1]) {
      patchOptions.allowCapabilitiesRaw = args[++i];
    } else if (args[i].startsWith('--allow-capabilities=')) {
      patchOptions.allowCapabilitiesRaw = args[i].slice('--allow-capabilities='.length);
    }
  }
  if (!patchOptions.strict && process.env.CCPATCH_STRICT === '1') {
    patchOptions.strict = true;
  }
  if (!patchOptions.dev && process.env.CCPATCH_DEV === '1') {
    patchOptions.dev = true;
  }

  return { inputPath, outputPath, requestedPatches, patchOptions, preloadPath, profile };
}

export async function runPatchCli(args, logger = console) {
  if (args.includes('--help') || args.includes('-h')) {
    logger.log(USAGE);
    return 0;
  }

  if (args[0] === 'module') {
    return await runModuleCommand(args.slice(1), logger);
  }

  const options = parsePatchCliArgs(args);
  if (options.error) {
    logger.log(options.error);
    return 1;
  }

  if (options.revert) {
    return await runRevert(options, logger);
  }
  if (options.diff) {
    return await runDiff(options, logger);
  }
  if (options.repl) {
    return await runReplCommand(options, logger);
  }
  if (options.versions) {
    return runVersions(options, logger);
  }
  if (options.refmap) {
    return await runRefmap(options, logger);
  }
  if (options.fallbackCapture) {
    return await runFallbackCapture(options, logger);
  }
  if (options.watch) {
    return await runWatch(options, logger);
  }
  if (options.coverage) {
    return await runCoverage(options, logger);
  }

  // For apply flows we want to load patches with the target version so the
  // correct variant is selected before validateManifest runs. For --list and
  // doctor we still load defaults only (variant dirs without defaults will
  // surface a clear load error).
  let loadVersion;
  if (options.patchOptions?.version) loadVersion = options.patchOptions.version;
  else if (process.env.CCPATCH_CLI_VERSION) loadVersion = process.env.CCPATCH_CLI_VERSION;
  const patches = await loadPatches({ version: loadVersion });

  if (options.list) {
    for (const name of Object.keys(patches).sort()) {
      const desc = patches[name].description ?? '';
      logger.log(`${name.padEnd(32)} ${desc}`);
    }
    return 0;
  }

  if (options.doctor) {
    return await runDoctor(options, patches, logger);
  }

  if (options.capabilities) {
    return await runCapabilities(options, patches, logger);
  }

  let code = fs.readFileSync(options.inputPath, 'utf8');

  // ── Feature flags via ccpatch.yml ──────────────────────────────────────────
  // When PATCH is unset or "all", read ccpatch.yml and filter by enabled flags.
  // Explicit PATCH=name1,name2 overrides bypass the YAML entirely.
  // --profile takes precedence over the patches: map when set.
  const isYamlMode = options.requestedPatches.length === 0
    || (options.requestedPatches.length === 1 && options.requestedPatches[0] === 'all');

  let effectiveRequested = options.requestedPatches;

  if (isYamlMode) {
    const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
    if (options.profile) {
      const profiles = readProfiles(yamlPath);
      const { enabled, unknown } = resolveProfile(options.profile, profiles, Object.keys(patches));
      if (unknown.length > 0) {
        logger.log(`  [config] profile "${options.profile}": ${unknown.length} unknown patch name(s) skipped: ${unknown.join(', ')}`);
      }
      logger.log(`[ccpatch] profile=${options.profile} patches=${enabled.length}`);
      effectiveRequested = enabled;
    } else {
      const yamlFlags = readPatchFlags(yamlPath);
      if (yamlFlags) {
        const allNames = Object.keys(patches);
        const unlisted = allNames.filter(name => !(name in yamlFlags));
        if (unlisted.length > 0) {
          logger.log(`  [config] ccpatch.yml: ${unlisted.length} unlisted patch(es) skipped (add to ccpatch.yml to enable): ${unlisted.join(', ')}`);
        }
        const enabled = allNames.filter(name => yamlFlags[name] === true);
        const disabled = allNames.filter(name => name in yamlFlags && yamlFlags[name] !== true);
        if (disabled.length > 0) {
          logger.log(`  [config] ccpatch.yml: ${enabled.length} enabled, ${disabled.length} disabled (${disabled.join(', ')})`);
        }
        effectiveRequested = enabled;
      } else {
        effectiveRequested = ['all'];
      }
    }
  }

  let patchesToApply = resolvePatchNames(patches, effectiveRequested);

  // When the user passed an explicit PATCH= list (not yaml-mode, not "all"),
  // auto-include any patch marked `required: true`. Without this, picking a
  // single extension drops infra patches like esm_compat and the output won't
  // run (e.g. ".mjs" output still contains the CJS IIFE wrapper).
  if (!isYamlMode && !effectiveRequested.includes('all')) {
    const selected = new Set(patchesToApply);
    const autoAdded = [];
    for (const [name, patch] of Object.entries(patches)) {
      if (patch && patch.required === true && !selected.has(name)) {
        selected.add(name);
        autoAdded.push(name);
      }
    }
    if (autoAdded.length > 0) {
      logger.log(`  [config] auto-including ${autoAdded.length} required patch(es): ${autoAdded.join(', ')}`);
      patchesToApply = [...selected];
    }
  }

  if (patchesToApply.length === 0) {
    logger.log(`No patches specified. Use --patch <name> or --patch all.`);
    return 0;
  }

  logger.log(`Applying ${patchesToApply.length} patches...`);

  const patchOptions = options.patchOptions || {};
  if (!patchOptions.version && process.env.CCPATCH_CLI_VERSION) {
    patchOptions.version = process.env.CCPATCH_CLI_VERSION;
  }

  // Strict mode requires --version (or CCPATCH_CLI_VERSION) so version-pinned
  // anchors in runner/anchors.mjs can resolve to a specific entry instead of
  // silently falling through to `default`.
  if (patchOptions.strict && !patchOptions.version) {
    logger.error(
      'Error: --strict requires --version <x.y.z> (or CCPATCH_CLI_VERSION env). ' +
      'Without a version, anchor entries in runner/anchors.mjs cannot pin to a release.'
    );
    return 1;
  }

  // ── Capability gate ───────────────────────────────────────────────────────
  // In strict mode, refuse to apply patches with `high`-risk capabilities
  // unless the user has explicitly acknowledged them via --allow-capabilities.
  // Non-strict mode: emit a warning but proceed.
  {
    const allow = parseAllowCapabilities(patchOptions.allowCapabilitiesRaw);
    if (allow && allow.unknown.length > 0) {
      logger.error(
        `Error: --allow-capabilities contains unknown value(s): ${allow.unknown.join(', ')}. ` +
        `Allowed: ${CAPABILITIES.join(', ')}`
      );
      return 1;
    }
    const violations = findGateViolations(patches, patchesToApply, allow);
    if (violations.length > 0) {
      const summary = violations
        .map(v => `  ${v.name.padEnd(28)} ${v.capabilities.join(', ')}  [missing: ${v.missing.join(', ')}]`)
        .join('\n');
      if (patchOptions.strict) {
        logger.error(
          `Error: --strict mode requires --allow-capabilities for high-risk patches:\n` +
          `${summary}\n` +
          `Pass --allow-capabilities <list> (or =all) to acknowledge.`
        );
        return 1;
      } else {
        logger.log(
          `  [capabilities] WARN: ${violations.length} high-risk patch(es) not acknowledged ` +
          `(non-strict mode, proceeding):\n${summary}`
        );
      }
    }
  }

  const originalCode = code;
  let hadNoChange = false;

  const activeLogger = patchOptions.dryRun ? {
    log: (...args) => { console.log(...args); },
    warn: (...args) => {
      const msg = args.join(' ');
      if (msg.includes('produced no changes')) hadNoChange = true;
      console.warn(...args);
    },
    error: console.error,
  } : logger;

  let patchedCode;
  let strictFailed = false;
  const captureReverse = [];
  patchOptions.captureReverse = captureReverse;
  try {
    patchedCode = await applyNamedPatches(code, patches, patchesToApply, activeLogger, patchOptions);
  } catch (err) {
    if (patchOptions.dryRun) {
      strictFailed = true;
      patchedCode = code; // best-effort: show whatever was applied before the throw
      logger.error(`[dry-run] Strict failure: ${err.message}`);
    } else {
      throw err;
    }
  }

  if (patchOptions.dryRun) {
    const { createPatch } = await import('diff');
    const diffOutput = createPatch(
      path.basename(options.inputPath),
      originalCode,
      patchedCode,
      'original',
      'patched'
    );
    process.stdout.write(diffOutput);

    // ── Shadow-mode semantic check ─────────────────────────────────────
    // Compare unpatched vs patched along several dimensions that pure
    // verify.present can't catch (weak verify, broken parse, forbidden
    // substrings, byte-identical no-op).
    const { runShadow, formatShadowReport } = await import('./shadow.mjs');
    const report = runShadow(originalCode, patchedCode, patches, patchesToApply);
    logger.log('');
    logger.log(formatShadowReport(report));

    if (patchOptions.writeOnClean && report.ok && !strictFailed && !hadNoChange) {
      // Safe-build path: only write when the shadow report is clean.
      fs.writeFileSync(options.outputPath, patchedCode, 'utf8');
      fs.chmodSync(options.outputPath, 0o755);
      logger.log(`\n[--write-on-clean] shadow report clean — wrote: ${options.outputPath}`);
      return 0;
    }

    if (strictFailed || hadNoChange) return 1;
    if (patchOptions.strict && !report.ok) return 1;
    return 0;
  }

  fs.writeFileSync(options.outputPath, patchedCode, 'utf8');
  fs.chmodSync(options.outputPath, 0o755);
  logger.log(`\nSuccessfully saved patched bundle to: ${options.outputPath}`);

  // Emit the overlay sibling file (Magisk-style overlay-don't-mutate). The
  // core/overlay_loader patch injects a single require() into the bundle that
  // pulls this file in at startup. Each enabled patch that declared
  // `overlay: { register, code }` contributes one __ccpProvide() block.
  try {
    const dev = patchOptions.dev === true;
    if (dev) {
      logger.log(`  [DEV MODE] shims hot-reload from ./ccpatch-overlay-shims/`);
    }
    const emitted = emitOverlay(patches, patchesToApply, path.dirname(options.outputPath), { dev });
    if (emitted) {
      logger.log(`  [+] Overlay file written to: ${emitted.overlayPath}`);
      if (dev && emitted.shimDir) {
        logger.log(`  [+] Hot-reload shims (${emitted.shimPaths.length}) written under: ${emitted.shimDir}`);
      }
    }
  } catch (err) {
    logger.warn(`  [!] Could not write overlay file: ${err.message}`);
  }

  // Write the reverse-diff sidecar so `ccpatch revert` can restore the input.
  if (captureReverse.length > 0) {
    const sidecar = {
      version: REVERT_SIDECAR_VERSION,
      timestamp: new Date().toISOString(),
      ccVersion: patchOptions.version ?? null,
      inputSha256: sha256(originalCode),
      outputSha256: sha256(patchedCode),
      patches: captureReverse,
    };
    const sidecarPath = sidecarPathFor(options.outputPath);
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
      logger.log(`  [+] Reverse-diff sidecar written to: ${sidecarPath}`);
    } catch (err) {
      logger.warn(`  [!] Could not write reverse-diff sidecar: ${err.message}`);
    }
  }

  if (options.preloadPath) {
    const preload = buildPreload(patches, patchesToApply);
    if (preload) {
      fs.writeFileSync(options.preloadPath, preload, 'utf8');
      logger.log(`  [+] Preload script written to: ${options.preloadPath}`);
      logger.log(`      Usage: node --require ${options.preloadPath} ${options.outputPath}`);
    } else {
      logger.log(`  [~] --preload: no preload-capable patches in current selection`);
    }
  }

  return 0;
}

/**
 * `ccpatch fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]`
 *
 * Print a unified diff (unpatched → patched) suitable for pasting into a
 * patch module's `fallbackDiff.patch` field. One-shot tool: does NOT modify
 * any patch file on disk.
 */
export async function runFallbackCapture(options, logger = console) {
  const { patchedPath, againstPath, patchName } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: patched bundle not found: ${patchedPath}`);
    return 1;
  }
  if (!fs.existsSync(againstPath)) {
    logger.error(`Error: unpatched bundle not found: ${againstPath}`);
    return 1;
  }
  const unpatched = fs.readFileSync(againstPath, 'utf8');
  const patched = fs.readFileSync(patchedPath, 'utf8');
  const { createPatch } = await import('diff');
  const label = patchName || path.basename(patchedPath);
  const diffOutput = createPatch(label, unpatched, patched, 'unpatched', 'patched');
  process.stdout.write(diffOutput);
  return 0;
}

async function runRefmap(options, logger) {
  const { buildRefmap, defaultRefmapPath, refmapsEqual } = await import('../tools/build-refmap.mjs');
  if (!fs.existsSync(options.bundlePath)) {
    logger.error(`Error: bundle not found: ${options.bundlePath}`);
    return 2;
  }
  const code = fs.readFileSync(options.bundlePath, 'utf8');
  const refmap = buildRefmap(code, { ccVersion: options.ccVersion });
  const outPath = options.outPath || defaultRefmapPath(options.ccVersion, refmap.bundleSha256);

  if (options.check) {
    if (!fs.existsSync(outPath)) {
      logger.error(`Error: --check expected refmap at ${outPath}; not found.`);
      return 1;
    }
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); }
    catch (err) {
      logger.error(`Error: existing refmap at ${outPath} is not valid JSON: ${err.message}`);
      return 1;
    }
    if (!refmapsEqual(existing, refmap)) {
      logger.error(`Refmap drift detected at ${outPath}. Regenerate with: ccpatch refmap ${options.bundlePath}${options.ccVersion ? ` --cc-version ${options.ccVersion}` : ''}`);
      return 1;
    }
    logger.log(`Refmap matches on-disk file: ${outPath}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(refmap, null, 2) + '\n', 'utf8');
  logger.log(`Wrote refmap: ${outPath}`);
  logger.log(`  ccVersion:   ${refmap.ccVersion ?? '(unset)'}`);
  logger.log(`  bundleSha:   ${refmap.bundleSha256.slice(0, 16)}…`);
  logger.log(`  resolved:    ${Object.keys(refmap.anchors).length}`);
  logger.log(`  misses:      ${refmap.misses.length}${refmap.misses.length ? ` (${refmap.misses.join(', ')})` : ''}`);
  return 0;
}

function runVersions(options, logger) {
  const targetVersion = options.targetVersion;
  const dirs = [
    { label: 'core', dir: path.join(PROJECT_ROOT, 'core') },
    { label: 'extensions', dir: path.join(PROJECT_ROOT, 'extensions') },
  ];

  const targetLabel = targetVersion ? `for target version ${targetVersion}` : '(no target version supplied)';
  logger.log(`Per-version patch variants ${targetLabel}:\n`);

  let anyVariants = false;
  for (const { label, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = enumeratePatchNames(dir);
    const versioned = entries.filter(e => e.hasVariantDir);
    if (versioned.length === 0) continue;
    anyVariants = true;
    logger.log(`[${label}/]`);
    for (const entry of versioned) {
      let variants = [];
      try {
        variants = scanVariantDir(entry.variantDir);
      } catch (err) {
        logger.log(`  ${entry.name.padEnd(32)} ERROR — ${err.message}`);
        continue;
      }
      const stems = variants.map(v => v.stem);
      let picked = 'default';
      if (targetVersion) {
        const best = pickBestVariant(variants, targetVersion);
        if (best) picked = best.stem;
      }
      const hasDefault = entry.hasDefault ? 'default + ' : '';
      logger.log(`  ${entry.name.padEnd(32)} variants: ${hasDefault}${stems.join(', ') || '(none)'}`);
      logger.log(`  ${''.padEnd(32)} → would pick: ${picked}`);
    }
    logger.log('');
  }
  if (!anyVariants) {
    logger.log('(no patches have per-version variant directories)');
  }
  return 0;
}

async function runDoctor(options, patches, logger) {
  if (!fs.existsSync(options.inputPath)) {
    logger.error(`Error: cli.js not found at ${options.inputPath}`);
    return 1;
  }
  const code = fs.readFileSync(options.inputPath, 'utf8');

  const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
  let names;
  if (options.profile) {
    const profiles = readProfiles(yamlPath);
    const { enabled, unknown } = resolveProfile(options.profile, profiles, Object.keys(patches));
    if (unknown.length > 0) {
      logger.log(`  [config] profile "${options.profile}": ${unknown.length} unknown patch name(s) skipped: ${unknown.join(', ')}`);
    }
    names = enabled;
    logger.log(`[ccpatch] profile=${options.profile} patches=${names.length}`);
  } else {
    const flags = readPatchFlags(yamlPath);
    names = flags
      ? Object.keys(patches).filter(n => flags[n] === true)
      : Object.keys(patches);
    logger.log(`[ccpatch] profile=(all enabled) patches=${names.length}`);
  }

  let ok = 0, drift = 0, missing = 0, unverified = 0;
  const unverifiedNames = [];
  const driftEntries = [];
  for (const name of names) {
    const patch = patches[name];
    if (!patch) {
      logger.log(`  MISSING      ${name} — patch not loaded`);
      missing++;
      continue;
    }
    // Declarative kinds (prefix/postfix/transpiler) synthesize apply() via
    // compileKind — mirror the runner so probeAnchor sees a real fn.
    const probePatch = (patch.kind && patch.kind !== 'free' && typeof patch.apply !== 'function')
      ? { ...patch, apply: compileKind(patch) }
      : patch;
    const res = probeAnchor(probePatch, code);
    if (patch.deprecated) {
      const sinceStr = patch.deprecated.since ? ` (since ${patch.deprecated.since})` : '';
      logger.log(`  DEPRECATED   ${name} — ${patch.deprecated.reason}${sinceStr}`);
      continue;
    }
    if (res.status === 'ok') {
      if (res.weak) {
        logger.log(`  UNVERIFIED   ${name} — verify only has 'present' (no absent/count); cannot detect wrong-location apply`);
        unverified++;
        unverifiedNames.push(name);
      } else {
        logger.log(`  OK           ${name}`);
        ok++;
      }
    } else if (res.status === 'drift') {
      logger.log(`  DRIFT        ${name} — ${res.detail}`);
      drift++;
      driftEntries.push({ name, patch, status: res.status, detail: res.detail });
    } else {
      logger.log(`  MISSING      ${name} — ${res.detail}`);
      missing++;
      driftEntries.push({ name, patch, status: res.status, detail: res.detail });
    }
  }

  // Emit one anchor-drift.jsonl entry per non-ok patch — same schema the runner
  // writes, so CI consumers see a unified stream.
  if (driftEntries.length > 0) {
    try {
      const version = options.patchOptions?.version ?? process.env.CCPATCH_CLI_VERSION ?? null;
      const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      fs.mkdirSync('storage/diagnostics', { recursive: true });
      const outPath = path.join('storage/diagnostics', 'anchor-drift.jsonl');
      for (const { name, patch, status, detail } of driftEntries) {
        const v = patch.verify ?? {};
        const presents = Array.isArray(v.present) ? v.present : (v.present ? [v.present] : []);
        const absents  = Array.isArray(v.absent)  ? v.absent  : (v.absent  ? [v.absent]  : []);
        const declaredLiteral = patch.anchor?.literal ?? null;
        const probes = [];
        if (declaredLiteral) probes.push({ source: 'anchor.literal', value: declaredLiteral });
        for (const p of presents) probes.push({ source: 'verify.present', value: p });
        for (const a of absents)  probes.push({ source: 'verify.absent',  value: a });
        const seen = new Set();
        const candidates = [];
        for (const { source, value } of probes) {
          if (typeof value !== 'string' || value.length < 4) continue;
          const hits = fuzzyMatch(code, new RegExp(escapeRe(value)));
          for (const h of hits) {
            const bucket = Math.floor(h.offset / 50);
            if (seen.has(bucket)) continue;
            seen.add(bucket);
            candidates.push({ source, probe: value.slice(0, 80), offset: h.offset, score: h.score, snippet: h.snippet.slice(0, 120) });
            if (candidates.length >= 3) break;
          }
          if (candidates.length >= 3) break;
        }
        const verifyFailed = [];
        for (const p of presents) if (!code.includes(p)) verifyFailed.push(`verify.present missing: ${p.slice(0, 80)}`);
        for (const a of absents)  if (code.includes(a))  verifyFailed.push(`verify.absent still present: ${a.slice(0, 80)}`);
        fs.appendFileSync(outPath, JSON.stringify({
          ts: new Date().toISOString(),
          type: 'anchor-drift',
          source: 'doctor',
          patch: name,
          version,
          status,
          detail: detail ?? null,
          anchor: {
            id: name,
            literal: declaredLiteral,
            verify_present: presents.map(s => s.slice(0, 80)),
            verify_absent:  absents.map(s => s.slice(0, 80)),
          },
          candidates,
          verify_failed: verifyFailed,
        }) + '\n', 'utf8');
      }
    } catch { /* non-fatal */ }
  }
  logger.log(`\n${ok} ok, ${drift} drifted, ${unverified} unverified, ${missing} missing`);
  if (unverified > 0 && !options.strict) {
    logger.log(`  [warning] ${unverified} patch(es) have weak verify (only 'present'). Strengthen with verify.absent or verify.count.`);
  }
  if (missing > 0) return 1;
  if (unverified > 0 && options.strict) {
    logger.error(`  [strict] UNVERIFIED treated as failure: ${unverifiedNames.join(', ')}`);
    return 1;
  }
  return 0;
}

function isBinaryTarget(p) {
  // v1 supports JS bundles only; Bun-compiled binaries / .exe are out of scope.
  const lower = p.toLowerCase();
  if (lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.cjs')) return false;
  if (lower.endsWith('.exe')) return true;
  // No extension or unknown extension: sniff for an ELF / Mach-O / PE header.
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // PE / MZ
    if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) return true; // Mach-O
    if (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa) return true; // Mach-O (be)
  } catch (_) { /* ignore */ }
  return false;
}

function readSidecar(patchedPath) {
  const sidecarPath = sidecarPathFor(patchedPath);
  if (!fs.existsSync(sidecarPath)) {
    return { error: `No reverse-diff sidecar at ${sidecarPath}. The bundle was not produced by a ccpatch version that captures reverse diffs, or the sidecar was deleted.` };
  }
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    return { error: `Sidecar ${sidecarPath} is not valid JSON: ${err.message}` };
  }
  if (sidecar.version !== REVERT_SIDECAR_VERSION) {
    return { error: `Sidecar version mismatch: expected ${REVERT_SIDECAR_VERSION}, got ${sidecar.version}` };
  }
  if (!Array.isArray(sidecar.patches)) {
    return { error: `Sidecar at ${sidecarPath} has no patches[] array` };
  }
  return { sidecar, sidecarPath };
}

/**
 * `ccpatch repl <patched.js>` — interactive REPL against a patched bundle.
 *
 * v1 supports JavaScript bundles only (.mjs/.js/.cjs). Bun-compiled binaries
 * are out of scope: they can't be `node -e`'d as a module.
 */
export async function runReplCommand(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  if (isBinaryTarget(patchedPath)) {
    logger.error(`Error: repl only supports JavaScript bundles (.mjs/.js/.cjs) in v1. ` +
      `Bun-compiled binaries are out of scope.`);
    return 1;
  }
  const { runRepl } = await import('../tools/repl.mjs');
  return await runRepl(patchedPath, options.replIo || {});
}

export async function runRevert(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  if (isBinaryTarget(patchedPath)) {
    logger.error(`Error: revert only supports JavaScript bundles (.mjs/.js/.cjs) in v1. ` +
      `Binary repack reversal is out of scope — re-extract from the original Bun executable instead.`);
    return 1;
  }
  const read = readSidecar(patchedPath);
  if (read.error) {
    logger.error(`Error: ${read.error}`);
    return 1;
  }
  const { sidecar } = read;

  const { applyPatch } = await import('diff');
  let current = fs.readFileSync(patchedPath, 'utf8');

  // Apply reverse diffs in reverse order: last-applied patch is undone first.
  const inOrder = sidecar.patches.slice().reverse();
  for (const entry of inOrder) {
    const beforeSha = sha256(current);
    if (entry.postSha256 && entry.postSha256 !== beforeSha) {
      logger.warn(`  [!] sha mismatch before reverting "${entry.name}": expected ${entry.postSha256.slice(0, 12)}, got ${beforeSha.slice(0, 12)} — proceeding, but the bundle may have been edited since patching.`);
    }
    const restored = applyPatch(current, entry.reverseDiff);
    if (restored === false) {
      logger.error(`Error: failed to apply reverse diff for "${entry.name}". The patched bundle has been modified since apply, or the sidecar is corrupted.`);
      return 1;
    }
    if (entry.preSha256 && sha256(restored) !== entry.preSha256) {
      logger.error(`Error: post-revert sha256 mismatch for "${entry.name}": expected ${entry.preSha256.slice(0, 12)}, got ${sha256(restored).slice(0, 12)}`);
      return 1;
    }
    current = restored;
    logger.log(`  [+] reverted: ${entry.name}`);
  }

  // The pre-state of patches[0] is the original input. Verify against the
  // recorded inputSha256 (and against patches[0].preSha256 for redundancy).
  const finalSha = sha256(current);
  const expectedSha = sidecar.inputSha256 ?? sidecar.patches[0]?.preSha256;
  if (expectedSha && finalSha !== expectedSha) {
    logger.error(`Error: restored bundle sha256 ${finalSha.slice(0, 12)} does not match original ${expectedSha.slice(0, 12)}`);
    return 1;
  }

  const outPath = options.outputPath ?? patchedPath;
  fs.writeFileSync(outPath, current, 'utf8');
  try { fs.chmodSync(outPath, 0o755); } catch (_) { /* ignore on platforms that reject */ }
  logger.log(`\nRestored ${sidecar.patches.length} patch(es). Wrote: ${outPath}`);
  return 0;
}

export async function runDiff(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  const read = readSidecar(patchedPath);
  if (read.error) {
    logger.error(`Error: ${read.error}`);
    return 1;
  }
  const { sidecar, sidecarPath } = read;
  logger.log(`Sidecar: ${sidecarPath}`);
  logger.log(`  ccVersion: ${sidecar.ccVersion ?? '(unset)'}`);
  logger.log(`  timestamp: ${sidecar.timestamp}`);
  logger.log(`  patches:   ${sidecar.patches.length}`);
  logger.log('');
  logger.log('  name'.padEnd(36) + '  +added  -removed');
  for (const entry of sidecar.patches) {
    // The stored diff is reverse (patched -> original). Forward diff line
    // counts are the inverse: '-' in reverseDiff = added by the forward
    // patch, '+' in reverseDiff = removed by the forward patch.
    let added = 0, removed = 0;
    for (const line of entry.reverseDiff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
      if (line.startsWith('-')) added++;
      else if (line.startsWith('+')) removed++;
    }
    logger.log(`  ${entry.name.padEnd(34)}  ${String(added).padStart(5)}  ${String(removed).padStart(7)}`);
  }
  return 0;
}

/**
 * `ccpatch capabilities [--profile NAME] [--json]`
 *
 * Print a table of every loaded patch alongside its declared capabilities
 * and computed risk class. Honors the same profile / ccpatch.yml selection
 * logic as `apply` so users see exactly what they'd enable.
 */
export async function runCapabilities(options, patches, logger) {
  const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
  let names;
  if (options.profile) {
    const profiles = readProfiles(yamlPath);
    const { enabled } = resolveProfile(options.profile, profiles, Object.keys(patches));
    names = enabled;
  } else {
    names = Object.keys(patches).sort();
  }

  const rows = names.map(name => {
    const p = patches[name] || {};
    const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
    return {
      name,
      capabilities: caps,
      risk: classifyRisk(caps),
    };
  });

  // Summary tallies per capability.
  const tally = {};
  for (const c of CAPABILITIES) tally[c] = 0;
  for (const r of rows) for (const c of r.capabilities) tally[c] = (tally[c] || 0) + 1;

  if (options.json) {
    logger.log(JSON.stringify({
      profile: options.profile || null,
      patches: rows,
      summary: tally,
    }, null, 2));
    return 0;
  }

  const nameW = Math.max(22, ...rows.map(r => r.name.length));
  const capsW = Math.max(20, ...rows.map(r => r.capabilities.join(', ').length));
  logger.log(`${'Patch'.padEnd(nameW)}  ${'Capabilities'.padEnd(capsW)}  Risk`);
  for (const r of rows) {
    logger.log(
      `${r.name.padEnd(nameW)}  ${(r.capabilities.join(', ') || '-').padEnd(capsW)}  ${r.risk}`
    );
  }
  const summaryParts = CAPABILITIES
    .filter(c => tally[c] > 0)
    .map(c => `${tally[c]} ${c}`);
  logger.log(`\nSummary: ${rows.length} patch(es)` +
    (summaryParts.length ? ` — ${summaryParts.join(', ')}` : ''));
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// `ccpatch module <subcommand>` — third-party patch module management.
// See CONTRIBUTING.md "Third-party patch modules".
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_USAGE =
  'Usage:\n' +
  '  ccpatch module install <path-or-url> [--strict] [--allow-capabilities <list>] [--force]\n' +
  '  ccpatch module list\n' +
  '  ccpatch module remove <name>\n' +
  '  ccpatch module verify <name>\n' +
  '  ccpatch module update <name>\n';

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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict') strict = true;
    else if (a === '--force') force = true;
    else if (a === '--allow-capabilities' && args[i + 1]) allowRaw = args[++i];
    else if (a.startsWith('--allow-capabilities=')) allowRaw = a.slice('--allow-capabilities='.length);
    else if (!a.startsWith('--') && !src) src = a;
  }
  if (!src) {
    logger.error('Error: module install requires a path or URL.\n' + MODULE_USAGE);
    return 1;
  }
  if (!strict && process.env.CCPATCH_STRICT === '1') strict = true;

  // Determine source kind.
  let sourceDir;
  let tmpRoot = null;
  if (/^git(\+|:)/.test(src) || src.endsWith('.git')) {
    logger.error('Error: git URLs are not supported in v1. Clone manually then `ccpatch module install <local-path>`, or publish a tarball.');
    return 1;
  } else if (/^https?:\/\//i.test(src)) {
    try {
      sourceDir = await fetchAndExtractTarball(src);
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

  // Signature check (pre-install): compare against the source-tree hash.
  if (typeof manifest.signature === 'string' && manifest.signature.length > 0) {
    const sourceHash = hashPatchesTree(require_path_join(sourceDir, 'patches'));
    if (sourceHash !== manifest.signature) {
      logger.error(`Error: signature mismatch — manifest declares ${manifest.signature.slice(0, 16)}…, computed ${sourceHash.slice(0, 16)}…. Refusing to install.`);
      return 1;
    }
    logger.log(`  signature: OK (sha256 ${manifest.signature.slice(0, 16)}…)`);
  } else {
    logger.log(`  signature: UNSIGNED — anyone with write access to the source could have tampered with patches/. Inspect the code before enabling.`);
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
      logger.log(`Installed ${result.manifest.name}@${result.manifest.version} → ${result.dir} (signature OK)`);
      return 0;
    } else {
      logger.error(`Error: post-install signature verification failed at ${result.dir}.`);
      return 1;
    }
  }
  logger.log(`Installed ${result.manifest.name}@${result.manifest.version} → ${result.dir}`);
  logger.log(`  WARN: this module is unsigned. Audit ${result.dir}/patches/ before enabling.`);
  return 0;
}

function moduleList(logger, projectRoot) {
  const mods = listModules(projectRoot);
  if (mods.length === 0) {
    logger.log(`No modules installed under ${modulesRoot(projectRoot)}.`);
    return 0;
  }
  const nameW = Math.max(20, ...mods.map(m => m.name.length));
  logger.log(`${'Name'.padEnd(nameW)}  Version    Signed  Path`);
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
    logger.log(`${r.name}: UNSIGNED`);
    logger.log(`  patches/ sha256: ${r.actual}`);
    logger.log(`  no signature in manifest — verification is informational only.`);
    return 0;
  }
  if (r.ok) {
    logger.log(`${r.name}: OK (sha256 ${r.actual.slice(0, 16)}… matches manifest.signature)`);
    return 0;
  }
  logger.error(`${r.name}: TAMPERED`);
  logger.error(`  expected: ${r.expected}`);
  logger.error(`  actual:   ${r.actual}`);
  return 1;
}

async function moduleUpdate(args, logger, projectRoot) {
  const name = args[0];
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
    channel = await fetchJson(manifest.updateChannel);
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
  if (!channel || typeof channel !== 'object'
      || typeof channel.version !== 'string'
      || typeof channel.url !== 'string') {
    logger.error(`Error: updateChannel ${manifest.updateChannel} did not return { version, url, signature? }`);
    return 1;
  }
  if (semverCompare(channel.version, manifest.version) <= 0) {
    logger.log(`${manifest.name} is up to date (${manifest.version} >= ${channel.version}).`);
    return 0;
  }
  logger.log(`[module] update available: ${manifest.version} → ${channel.version}`);
  let sourceDir;
  try {
    sourceDir = await fetchAndExtractTarball(channel.url);
  } catch (err) {
    logger.error(`Error: ${err.message}`);
    return 1;
  }
  // Override signature on the fetched manifest if channel pinned one.
  if (typeof channel.signature === 'string' && channel.signature.length > 0) {
    const fetched = readModuleManifest(sourceDir);
    const sourceHash = hashPatchesTree(require_path_join(sourceDir, 'patches'));
    if (sourceHash !== channel.signature) {
      logger.error(`Error: channel signature mismatch — channel=${channel.signature.slice(0, 16)}…, computed=${sourceHash.slice(0, 16)}…`);
      return 1;
    }
    // Force the update path to use channel's signature even if manifest disagrees.
    if (fetched.signature !== channel.signature) {
      fetched.signature = channel.signature;
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

/**
 * `ccpatch coverage <patched-bundle> [--smoke <cmd>] [--out report.json] [--cc-version X.Y.Z]`
 *
 * Cross-reference apply-time coverage (storage/outputs/coverage-apply-v<ver>.json,
 * written by applyNamedPatches) with runtime hits captured from the bundle.
 *
 * Runtime hits are read via stdin/stdout: the coverage_kernel patch dumps the
 * map on SIGTERM and on process exit, prefixed with "__CCP_COV__". We spawn
 * the bundle (`node patched.js` by default, or the user's --smoke command),
 * scan stdout for the prefix line, and parse the JSON payload.
 *
 * Exits non-zero if any patch is DEAD (applied but never executed).
 */
export async function runCoverage(options, logger = console) {
  const { spawn } = await import('node:child_process');
  const { bundlePath, smoke, outPath, ccVersion } = options;
  if (!fs.existsSync(bundlePath)) {
    logger.error(`Error: bundle not found: ${bundlePath}`);
    return 2;
  }
  // Locate the apply-time manifest. Try versioned then 'unknown'.
  const candidates = [];
  if (ccVersion) candidates.push(`storage/outputs/coverage-apply-v${ccVersion}.json`);
  candidates.push('storage/outputs/coverage-apply-unknown.json');
  // Fall back: any coverage-apply-*.json in the outputs dir.
  try {
    const dir = 'storage/outputs';
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('coverage-apply-') && f.endsWith('.json')) {
          const full = path.join(dir, f);
          if (!candidates.includes(full)) candidates.push(full);
        }
      }
    }
  } catch (_) { /* non-fatal */ }
  let applyManifest = null;
  let applyManifestPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        applyManifest = JSON.parse(fs.readFileSync(c, 'utf8'));
        applyManifestPath = c;
        break;
      } catch (_) { /* skip */ }
    }
  }
  if (!applyManifest) {
    logger.error('Error: no apply-time coverage manifest found in storage/outputs/. Run apply first.');
    return 2;
  }
  logger.log(`[coverage] apply-time manifest: ${applyManifestPath}`);

  // Spawn the bundle / smoke command and capture stdout.
  let cmd, args;
  if (smoke) {
    // The smoke string is a shell-style command; split on whitespace (simple).
    const parts = smoke.match(/\S+/g) || [];
    cmd = parts[0];
    args = parts.slice(1);
    if (!cmd) {
      logger.error('Error: --smoke value is empty');
      return 2;
    }
  } else {
    cmd = process.execPath;
    args = [bundlePath, '--version'];
  }

  logger.log(`[coverage] running: ${cmd} ${args.join(' ')}`);
  const runtimeHits = await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString('utf8'); });
    child.stderr.on('data', () => { /* ignored */ });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Find the last __CCP_COV__ payload in stdout.
      const lines = buf.split('\n');
      let payload = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        const idx = ln.indexOf('__CCP_COV__');
        if (idx !== -1) { payload = ln.slice(idx + '__CCP_COV__'.length); break; }
      }
      let parsed = {};
      if (payload) {
        try { parsed = JSON.parse(payload); } catch (_) { parsed = {}; }
      }
      resolve(parsed);
    };
    child.on('exit', finish);
    child.on('error', () => finish());
    // Hard cap so a hung bundle doesn't wedge the coverage run. Both timers
    // are unref'd so a fast-exiting child closes the event loop immediately.
    const capMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const t1 = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {}; finish(); }, 250);
      t2.unref?.();
    }, capMs);
    t1.unref?.();
  });

  // Cross-reference and build the report.
  const rows = [];
  let deadCount = 0;
  for (const name of Object.keys(applyManifest.patches).sort()) {
    const entry = applyManifest.patches[name];
    const hits = typeof runtimeHits[entry.coverageMarker] === 'number'
      ? runtimeHits[entry.coverageMarker]
      : 0;
    const applied = !!entry.applied;
    const instrumented = !!entry.coverageMarker;
    let status;
    if (!applied) {
      status = 'SKIPPED';
    } else if (!instrumented) {
      status = 'UNINSTRUMENTED';
    } else if (hits > 0) {
      status = 'LIVE';
    } else {
      status = 'DEAD';
      deadCount++;
    }
    rows.push({ name, applied, hits, instrumented, status, marker: entry.coverageMarker ?? null });
  }

  // Print markdown table.
  const headers = ['Patch', 'Applied', 'Hit', 'Status'];
  const widths = [
    Math.max(headers[0].length, ...rows.map(r => r.name.length)),
    headers[1].length,
    headers[2].length,
    Math.max(headers[3].length, ...rows.map(r => r.status.length)),
  ];
  const cell = (s, w) => String(s).padEnd(w);
  logger.log('');
  logger.log(`${cell(headers[0], widths[0])}  ${cell(headers[1], widths[1])}  ${cell(headers[2], widths[2])}  ${cell(headers[3], widths[3])}`);
  logger.log(`${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}  ${'-'.repeat(widths[3])}`);
  for (const r of rows) {
    const appliedStr = r.applied ? 'yes' : 'no';
    const hitStr = r.instrumented ? (r.hits > 0 ? 'yes' : 'no') : '-';
    logger.log(`${cell(r.name, widths[0])}  ${cell(appliedStr, widths[1])}  ${cell(hitStr, widths[2])}  ${cell(r.status, widths[3])}`);
  }
  logger.log('');
  logger.log(`[coverage] ${rows.length} patches, ${deadCount} DEAD`);

  if (outPath) {
    const report = {
      ccVersion: applyManifest.ccVersion ?? null,
      bundlePath,
      runAt: new Date().toISOString(),
      runtimeHits,
      patches: rows,
      deadCount,
    };
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
      logger.log(`[coverage] report written to: ${outPath}`);
    } catch (err) {
      logger.warn(`[coverage] could not write report: ${err.message}`);
    }
  }

  return deadCount > 0 ? 1 : 0;
}

// A1: `ccpatch doctor` handler (+ probe core and anchor-drift.jsonl writer),
// split out of cli.mjs.

import fs from 'node:fs';
import path from 'node:path';

import { runDoctorSuggest } from './doctor-suggest.mjs';
import { readPatchFlags, readProfiles } from '../config.mjs';
import { resolveProfile } from '../manifest.mjs';
import { probeAnchor } from '../anchors.mjs';
import { compileKind } from '../patch-kinds.mjs';
import { buildDriftRecord } from '../drift-record.mjs';
import { PROJECT_ROOT } from '../paths.mjs';

/**
 * Best-effort source path for a patch by name. Loaded patch objects don't carry
 * their filePath, so probe the two well-known trees. Used only to make the
 * UNVERIFIED nudge point at a concrete file; falls back to a bare name.
 */
function patchFileHint(name) {
  for (const sub of ['extensions', 'core']) {
    const p = path.join(PROJECT_ROOT, sub, `${name}.mjs`);
    if (fs.existsSync(p)) return path.relative(PROJECT_ROOT, p);
  }
  return `<core|extensions>/${name}.mjs`;
}

/**
 * `ccpatch doctor` command entry (table run). Wraps the probe core so the
 * `--suggest` follow-up (read anchor-drift.jsonl + print candidates) stays
 * attached to the command exactly as the old runPatchCli dispatch did.
 * ctx = { options, patches, logger }.
 */
export async function runDoctor(ctx) {
  const { options, patches, logger } = ctx;
  const rc = await runDoctorCore(options, patches, logger);
  if (options.suggest) {
    logger.log('');
    runDoctorSuggest(logger);
  }
  return rc;
}

export async function runDoctorCore(options, patches, logger) {
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
        logger.log(
          `  UNVERIFIED   ${name} — verify only has 'present' (no absent/count); cannot detect wrong-location apply\n` +
          `                 fix ${patchFileHint(name)}: change verify to ` +
          `{ present: '<marker>', count: { present: 1 } } (assert it landed exactly once)`
        );
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
  //
  // U4: write to storage/outputs/anchor-drift.jsonl (the CANONICAL path the
  // runner already uses and `heal` reads by default). The doctor previously
  // wrote to storage/diagnostics/, which `heal` never saw — so doctor-discovered
  // drift never reached the fix loop. One path closes that seam.
  //
  // A5: forensics (probes → fuzzyMatch → dedupe → top 3 → record) come from the
  // shared buildDriftRecord() helper. Passing source/status/detail preserves the
  // doctor-only fields and keeps the JSONL byte-compatible with the old writer.
  if (driftEntries.length > 0) {
    const version = options.patchOptions?.version ?? process.env.CCPATCH_CLI_VERSION ?? null;
    // S5: first storage-write failure of this command warns once; rest stay quiet.
    let storageWarned = false;
    fs.mkdirSync('storage/outputs', { recursive: true });
    const outPath = path.join('storage/outputs', 'anchor-drift.jsonl');
    for (const { name, patch, status, detail } of driftEntries) {
      const v = patch.verify ?? {};
      const { record } = buildDriftRecord(
        code,
        { literal: patch.anchor?.literal ?? null, present: v.present, absent: v.absent },
        { source: 'doctor', patchName: name, version, status, detail: detail ?? null },
      );
      try {
        fs.appendFileSync(outPath, JSON.stringify(record) + '\n', 'utf8');
      } catch (err) {
        if (!storageWarned) {
          storageWarned = true;
          logger.warn?.(`  [!] Storage write failed (anchor-drift.jsonl): ${err.message}. Further failures this run will be silent.`);
        }
      }
    }
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

// `ccpatch outputs clear` — inspect and optionally delete or rotate the
// JSONL/JSON files written to storage/outputs/ by doctor, runner, and CI.

import fs from 'node:fs';
import path from 'node:path';

/** Bytes → human-readable string. */
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Scan a directory for *.jsonl and *.json files.
 * Returns an array of { file (absolute path), size (bytes) }.
 */
function scanOutputs(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl') && !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // If stat fails skip silently — the file may have disappeared.
      continue;
    }
    entries.push({ file, size });
  }
  // Sort deterministically: by name within the directory.
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return entries;
}

/**
 * Rotate a JSONL file: keep only the last `keepBytes` bytes worth of lines.
 * Lines are newline-delimited JSON records. Oldest lines are dropped until the
 * retained content fits within keepBytes. The file is rewritten atomically
 * (write to .tmp, then rename).
 *
 * Returns { kept, dropped, newSize }.
 */
function rotateJsonl(filePath, keepBytes) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  // Preserve a trailing newline if present.
  const trailingNewline = raw.endsWith('\n');
  const nonEmpty = lines.filter(l => l.length > 0);

  // Walk from the tail and accumulate until we exceed keepBytes.
  let acc = 0;
  let cutIdx = nonEmpty.length; // index of the first line to keep (from the end)
  for (let i = nonEmpty.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(nonEmpty[i] + '\n', 'utf8');
    if (acc + lineBytes > keepBytes) {
      cutIdx = i + 1;
      break;
    }
    acc += lineBytes;
    cutIdx = i;
  }

  const kept = nonEmpty.slice(cutIdx);
  const dropped = nonEmpty.length - kept.length;
  const newContent = kept.join('\n') + (trailingNewline || kept.length > 0 ? '\n' : '');
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, newContent, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return { kept: kept.length, dropped, newSize: Buffer.byteLength(newContent, 'utf8') };
}

/**
 * Rotate a JSON file: this file type has no per-line granularity, so rotation
 * simply truncates to the last keepBytes bytes of the raw file. Because the
 * result is likely not valid JSON after truncation we warn and skip if the
 * file is already within the limit; otherwise we delete it.
 *
 * For JSON (non-JSONL) files we treat rotation as a delete when the file
 * exceeds the limit, since there is no meaningful "keep last N bytes of JSON".
 *
 * Returns { action: 'kept' | 'deleted', newSize }.
 */
function rotateJson(filePath, keepBytes, logger) {
  const size = fs.statSync(filePath).size;
  if (size <= keepBytes) {
    return { action: 'kept', newSize: size };
  }
  // Delete: non-JSONL files can't be line-trimmed meaningfully.
  logger.warn?.(`  [outputs] ${path.basename(filePath)}: JSON file exceeds rotate limit — deleting (no line-level rotation for .json)`);
  fs.unlinkSync(filePath);
  return { action: 'deleted', newSize: 0 };
}

/**
 * `ccpatch outputs clear` entry point.
 * ctx = { options, logger }
 *   options.force    — delete without prompting
 *   options.rotateKb — if set (number), rotate instead of delete
 *   options.outputsDir — override the default storage/outputs path (for tests)
 */
export async function runOutputsClear(ctx) {
  const { options, logger } = ctx;
  const dir = options.outputsDir
    ? path.resolve(options.outputsDir)
    : path.resolve('storage/outputs');

  const entries = scanOutputs(dir);

  if (entries.length === 0) {
    logger.log(`[outputs] ${dir} is empty — nothing to do.`);
    return 0;
  }

  // Print the file list.
  logger.log(`[outputs] Files in ${dir}:`);
  for (const { file, size } of entries) {
    logger.log(`  ${path.relative(dir, file).padEnd(36)} ${fmtSize(size).padStart(9)}`);
  }
  logger.log('');

  const n = entries.length;
  const rotateKb = options.rotateKb != null ? Number(options.rotateKb) : null;

  if (!options.force) {
    if (rotateKb != null) {
      logger.log(`Run with --force to rotate these ${n} file(s) (keep last ${rotateKb} KB each).`);
    } else {
      logger.log(`Run with --force to delete these ${n} file(s).`);
    }
    return 0;
  }

  // Execute: rotate or delete.
  let ok = 0;
  let fail = 0;

  for (const { file, size } of entries) {
    const rel = path.relative(dir, file);
    if (rotateKb != null) {
      const keepBytes = rotateKb * 1024;
      try {
        if (file.endsWith('.jsonl')) {
          const { kept, dropped, newSize } = rotateJsonl(file, keepBytes);
          logger.log(`  rotated  ${rel} — kept ${kept} line(s), dropped ${dropped}, now ${fmtSize(newSize)} (was ${fmtSize(size)})`);
          ok++;
        } else {
          const { action } = rotateJson(file, keepBytes, logger);
          if (action === 'kept') {
            logger.log(`  skipped  ${rel} — within limit (${fmtSize(size)})`);
          } else {
            logger.log(`  deleted  ${rel} — was ${fmtSize(size)}`);
          }
          ok++;
        }
      } catch (err) {
        logger.error(`  FAILED   ${rel} — ${err.message}`);
        fail++;
      }
    } else {
      try {
        fs.unlinkSync(file);
        logger.log(`  deleted  ${rel} — was ${fmtSize(size)}`);
        ok++;
      } catch (err) {
        logger.error(`  FAILED   ${rel} — ${err.message}`);
        fail++;
      }
    }
  }

  logger.log('');
  logger.log(`[outputs] ${ok} succeeded, ${fail} failed.`);
  return fail > 0 ? 1 : 0;
}

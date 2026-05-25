/**
 * Dry-run / shadow mode.
 *
 * After `applyNamedPatches` has produced a patched bundle in memory, this
 * module verifies that the patch operation actually does what it claims —
 * without writing anything to disk. It catches semantic drift that the
 * existing `verify.present` cannot:
 *
 *   - bytes:        delta is suspiciously zero (no-op apply slipped through)
 *   - verify:       a `verify.present` sentinel already exists in the
 *                   *unpatched* bundle (weak verify — would pass even if the
 *                   patch had done nothing).
 *   - parse:        unpatched bundle parses cleanly, patched bundle does not
 *                   (the patch broke syntax).
 *   - forbidden:    the patched bundle contains a substring the patch (or
 *                   the user) declared must NOT appear post-apply.
 *
 * Returns `{ ok, anomalies: [{ kind, patch?, detail }] }`.
 *
 * This is a *check*, not a transform. It never mutates inputs and never
 * writes to disk.
 */

import * as acorn from 'acorn';

const ACORN_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: true };

function toList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function tryParse(code) {
  try {
    acorn.parse(code, ACORN_OPTS);
    return { ok: true };
  } catch (err) {
    // Fall back to script sourceType — some bundles are CJS-IIFE.
    try {
      acorn.parse(code, { ...ACORN_OPTS, sourceType: 'script' });
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: err.message };
    }
  }
}

/**
 * @param {string} unpatched - original bundle text
 * @param {string} patched   - bundle text after applyNamedPatches
 * @param {object} patches   - patches registry (name → normalized patch)
 * @param {string[]} names   - patch names that were applied
 * @param {object} [opts]    - { extraForbidden?: string[] }
 */
export function runShadow(unpatched, patched, patches, names, opts = {}) {
  const anomalies = [];

  // ── bytes ─────────────────────────────────────────────────────────────
  const delta = patched.length - unpatched.length;
  if (patched === unpatched) {
    anomalies.push({
      kind: 'bytes',
      detail: `patched bundle is byte-identical to unpatched (${patched.length} bytes) — no patch produced a change`,
    });
  }

  // ── verify ────────────────────────────────────────────────────────────
  // Catch "weak verify": a verify.present sentinel that already exists in
  // the unpatched bundle. The verify block would pass even if the apply
  // function were replaced with the identity.
  for (const name of names) {
    const patch = patches[name];
    if (!patch || !patch.verify) continue;
    for (const sentinel of toList(patch.verify.present)) {
      if (typeof sentinel !== 'string' || sentinel.length === 0) continue;
      const inUnpatched = unpatched.includes(sentinel);
      const inPatched = patched.includes(sentinel);
      if (inUnpatched && inPatched) {
        anomalies.push({
          kind: 'verify',
          patch: name,
          detail: `weak verify.present: sentinel ${JSON.stringify(sentinel.slice(0, 40))}${sentinel.length > 40 ? '…' : ''} already exists in the unpatched bundle`,
        });
      } else if (!inPatched) {
        anomalies.push({
          kind: 'verify',
          patch: name,
          detail: `verify.present sentinel missing from patched bundle: ${JSON.stringify(sentinel.slice(0, 40))}`,
        });
      }
    }
  }

  // ── parse ─────────────────────────────────────────────────────────────
  // If unpatched parses but patched does not, the patch broke syntax.
  const unpatchedParse = tryParse(unpatched);
  const patchedParse = tryParse(patched);
  if (unpatchedParse.ok && !patchedParse.ok) {
    anomalies.push({
      kind: 'parse',
      detail: `patched bundle fails to parse but unpatched parsed cleanly: ${patchedParse.error}`,
    });
  }

  // ── forbidden ─────────────────────────────────────────────────────────
  // Collect forbidden substrings from each patch's `forbiddenAfterPatch`
  // field, plus any extras the caller passed in.
  const forbiddenList = [];
  for (const name of names) {
    const patch = patches[name];
    if (!patch || !Array.isArray(patch.forbiddenAfterPatch)) continue;
    for (const s of patch.forbiddenAfterPatch) {
      if (typeof s === 'string' && s.length > 0) {
        forbiddenList.push({ patch: name, sentinel: s });
      }
    }
  }
  for (const s of toList(opts.extraForbidden)) {
    if (typeof s === 'string' && s.length > 0) {
      forbiddenList.push({ patch: null, sentinel: s });
    }
  }
  for (const { patch: pname, sentinel } of forbiddenList) {
    if (patched.includes(sentinel)) {
      anomalies.push({
        kind: 'forbidden',
        patch: pname || undefined,
        detail: `forbidden substring present in patched bundle: ${JSON.stringify(sentinel.slice(0, 40))}${sentinel.length > 40 ? '…' : ''}`,
      });
    }
  }

  return {
    ok: anomalies.length === 0,
    anomalies,
    stats: {
      unpatchedBytes: unpatched.length,
      patchedBytes: patched.length,
      delta,
    },
  };
}

/**
 * Render a shadow report as a plain-text table for terminal output.
 * Pure function — produces a string. Caller writes to logger.
 */
export function formatShadowReport(report, opts = {}) {
  const lines = [];
  const { unpatchedBytes, patchedBytes, delta } = report.stats;
  lines.push(`[shadow] bytes: unpatched=${unpatchedBytes} patched=${patchedBytes} delta=${delta >= 0 ? '+' : ''}${delta}`);

  if (report.anomalies.length === 0) {
    lines.push(`[shadow] clean — 0 anomalies`);
    return lines.join('\n');
  }

  lines.push(`[shadow] ${report.anomalies.length} anomaly(ies):`);
  lines.push('  ' + 'kind'.padEnd(10) + '  ' + 'patch'.padEnd(28) + '  detail');
  for (const a of report.anomalies) {
    lines.push('  ' + (a.kind || '?').padEnd(10) + '  ' + (a.patch || '-').padEnd(28) + '  ' + a.detail);
  }
  return lines.join('\n');
}

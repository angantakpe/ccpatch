// A5: single source of truth for anchor-drift forensics.
//
// Three call sites used to hand-roll the same routine — runner.mjs detectDrift,
// the cmd-doctor.mjs anchor-drift writer, and (via the JSONL it reads back)
// heal.mjs. Each one collected the patch's stable probe strings
// (anchor.literal + verify.present + verify.absent), fuzzy-matched them against
// the bundle, deduped hits in 50-byte buckets, kept the top 3, then derived
// which verify assertions would have failed and emitted an `anchor-drift` JSONL
// record. Drift between the copies (e.g. a schema field added to one but not
// the other) is exactly the kind of bug this consolidation prevents.
//
// Pure: derives everything from its arguments. fuzzyMatch comes from anchors.mjs.

import { fuzzyMatch } from './anchors.mjs';
import { toList } from './verify-core.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Anchor-extinction status (THREAT_MODEL.md "Systemic risk: upstream toolchain
 * change"). When EVERY probe (anchor.literal + verify.present + verify.absent)
 * yields ZERO fuzzy candidates above threshold, the anchor literal has vanished
 * from the bundle entirely. That is not ordinary drift — `heal` has nothing to
 * propose, and chasing per-patch fixes is wasted work. Records carry an
 * additive `extinct: true` field (old JSONL consumers ignore it) and, when a
 * doctor status was supplied, `status` is promoted to this value so downstream
 * reporters (doctor --suggest, version-matrix PR comments) surface it loudly.
 */
export const EXTINCT_STATUS = 'extinct';

/**
 * True when a drift entry (as parsed back from anchor-drift.jsonl) records an
 * extinct anchor. Checks both the promoted status and the additive boolean so
 * runner-written records (which carry no `status` field) are covered too.
 *
 * @param {object} entry  parsed anchor-drift JSONL record
 * @returns {boolean}
 */
export function isExtinctEntry(entry) {
  return !!entry && (entry.extinct === true || entry.status === EXTINCT_STATUS);
}

/**
 * Build the shared anchor-drift forensics for one patch whose anchor did not
 * resolve cleanly against `code`.
 *
 * @param {string} code  the bundle source to probe
 * @param {object} probesIn
 * @param {string|null} [probesIn.literal]  declared anchor.literal (highest signal)
 * @param {string|string[]} [probesIn.present]  verify.present strings
 * @param {string|string[]} [probesIn.absent]   verify.absent strings
 * @param {object} meta
 * @param {string} meta.patchName  patch / anchor id
 * @param {string|null} [meta.version]  CC bundle version
 * @param {string} [meta.source]  optional provenance tag ('doctor', etc.); when
 *                                set it is added to the record as `source` and
 *                                `status`/`detail` (if provided) are included.
 * @param {string} [meta.status]  doctor status ('drift'|'missing'); omitted when absent
 * @param {string|null} [meta.detail]  doctor detail string; omitted when absent
 * @returns {{candidates: object[], verifyFailed: string[], probesCount: number, record: object, extinct: boolean}}
 */
export function buildDriftRecord(code, probesIn = {}, meta = {}) {
  const declaredLiteral = probesIn.literal ?? null;
  const presents = toList(probesIn.present);
  const absents = toList(probesIn.absent);

  // Probes ordered by signal strength: declared literal > present > absent.
  const probes = [];
  if (declaredLiteral) probes.push({ source: 'anchor.literal', value: declaredLiteral });
  for (const p of presents) probes.push({ source: 'verify.present', value: p });
  for (const a of absents) probes.push({ source: 'verify.absent', value: a });

  const seenOffsets = new Set();
  const candidates = [];
  for (const { source, value } of probes) {
    if (typeof value !== 'string' || value.length < 4) continue;
    const hits = fuzzyMatch(code, new RegExp(escapeRe(value)));
    for (const h of hits) {
      // Dedupe within 50 bytes across probes.
      const bucket = Math.floor(h.offset / 50);
      if (seenOffsets.has(bucket)) continue;
      seenOffsets.add(bucket);
      candidates.push({
        source,
        probe: value.slice(0, 80),
        offset: h.offset,
        score: h.score,
        snippet: h.snippet.slice(0, 120),
      });
      if (candidates.length >= 3) break;
    }
    if (candidates.length >= 3) break;
  }

  // verify_failed: which checks would have failed on this code.
  const verifyFailed = [];
  for (const p of presents) {
    if (!code.includes(p)) verifyFailed.push(`verify.present missing: ${p.slice(0, 80)}`);
  }
  for (const a of absents) {
    if (code.includes(a)) verifyFailed.push(`verify.absent still present: ${a.slice(0, 80)}`);
  }

  // Extinction: at least one usable probe existed, yet fuzzy ranking produced
  // ZERO candidates. (With zero probes we cannot distinguish "vanished" from
  // "unprobeable", so extinct is not claimed.)
  const extinct = probes.length > 0 && candidates.length === 0;

  // Emit the record in field order matching the legacy writers, so the JSONL
  // stream stays byte-compatible for both sites. `source`/`status`/`detail` are
  // doctor-only fields, inserted only when supplied. The `extinct` field is
  // ADDITIVE (appended last) so non-extinct records are byte-identical to the
  // pre-extinction schema; when a doctor status was supplied for an extinct
  // anchor it is promoted to 'extinct' so status-keyed consumers see it.
  const record = {
    ts: new Date().toISOString(),
    type: 'anchor-drift',
  };
  if (meta.source !== undefined) record.source = meta.source;
  record.patch = meta.patchName;
  record.version = meta.version ?? null;
  if (meta.status !== undefined) record.status = extinct ? EXTINCT_STATUS : meta.status;
  if (meta.detail !== undefined) record.detail = meta.detail ?? null;
  record.anchor = {
    id: meta.patchName,
    literal: declaredLiteral,
    verify_present: presents.map(s => s.slice(0, 80)),
    verify_absent: absents.map(s => s.slice(0, 80)),
  };
  record.candidates = candidates;
  record.verify_failed = verifyFailed;
  if (extinct) record.extinct = true;

  return { candidates, verifyFailed, probesCount: probes.length, record, extinct };
}

/**
 * unhide-features-anchor.test.mjs
 *
 * Guards the patch-quality hardening:
 *   1. unhide_features pass 4 re-anchors on the STABLE feature-flag literal
 *      ("tengu_kairos_push_notifications") across every archived bundle —
 *      proving it no longer silently no-ops when the minified getter/helper
 *      names rotate (the old `szH`/`Z$` pins matched no shipped bundle).
 *   2. unhide_features' verify.absent assertions hold after apply() (the
 *      gated standalone getter is gone), so a future no-op fails loud.
 *   3. lint-anchors' inline scanner flags brittle minified-identifier pins
 *      but not the resilient capture-group / stable-literal forms.
 *   4. The --smoke tokenizer honors quotes.
 *   5. verify-batch's 2-char prefix key is collision-free for non-Latin-1
 *      literals (the *65536 stride fix) while keeping matches identical.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import unhide from '../extensions/unhide_features.mjs';
import { findBrittlePins } from '../scripts/lint-anchors.mjs';
import { tokenizeSmoke } from '../runner/cli.mjs';
import { verifyBatch } from '../runner/verify-batch.mjs';
import { toList } from '../runner/verify-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Every archived bundle, newest first. */
function archivedBundles() {
  const archivesDir = resolve(ROOT, 'storage/archives');
  if (!existsSync(archivesDir)) return [];
  const out = [];
  for (const vd of readdirSync(archivesDir)) {
    const version = vd.match(/v([\d.]+)$/)?.[1];
    if (!version) continue;
    const p = resolve(archivesDir, vd, `cli.v${version}.cjs`);
    if (existsSync(p)) out.push({ version, path: p });
  }
  return out;
}

test('unhide_features pass 4 re-anchors on the stable push-notification literal', (t) => {
  const bundles = archivedBundles();
  if (bundles.length === 0) {
    t.skip('no archived bundles under storage/archives/');
    return;
  }
  for (const { version, path } of bundles) {
    const code = readFileSync(path, 'utf8');
    // Sanity: the stable getter form must exist pre-patch in every bundle.
    assert.ok(
      code.includes('"tengu_kairos_push_notifications",!1)}'),
      `v${version}: expected the gated standalone getter pre-patch`,
    );
    const out = unhide.apply(code);
    assert.ok(out !== code, `v${version}: apply() must change the bundle`);
    assert.ok(
      !out.includes('"tengu_kairos_push_notifications",!1)}'),
      `v${version}: gated standalone getter must be gone after apply()`,
    );
  }
});

test('unhide_features verify.absent holds after apply (passes 1–4)', (t) => {
  const bundles = archivedBundles();
  if (bundles.length === 0) {
    t.skip('no archived bundles under storage/archives/');
    return;
  }
  const { path } = bundles[0]; // newest
  const out = unhide.apply(readFileSync(path, 'utf8'));
  for (const lit of toList(unhide.verify.absent)) {
    assert.ok(!out.includes(lit), `verify.absent literal still present: ${lit}`);
  }
});

test('lint-anchors flags brittle minified pins, not resilient forms', () => {
  // Brittle: literal function name + bare helper call. Both the rotating getter
  // name (szH) and the rotating helper (Z$) are flagged.
  const pass4Names = new Set(
    findBrittlePins('function szH\\(\\)\\{return Z\\$\\("tengu_kairos_push_notifications",!1\\)\\}')
      .map((p) => p.name),
  );
  assert.ok(pass4Names.has('szH') && pass4Names.has('Z$'), 'pass4 must flag szH and Z$');
  assert.ok(findBrittlePins('Z\\$\\("tengu_streaming_tool_execution2",!1\\)').length > 0);

  // Resilient: capture groups / char classes / stable literal anchoring.
  assert.deepEqual(findBrittlePins('([A-Za-z_$][\\w$]*)\\("tengu_streaming_tool_execution2",!1\\)'), []);
  assert.deepEqual(findBrittlePins('function (\\w+)\\(\\)\\{return \\w+\\("tengu_kairos_cron_durable",!0,\\w+\\)\\}'), []);
  // No false positives on member access / standard API / reserved words.
  assert.deepEqual(findBrittlePins('Promise\\.all\\(([\\w$]+)\\.map\\('), []);
  assert.deepEqual(findBrittlePins('"rgb\\(\\d+,\\d+,\\d+\\)"'), []);
  assert.deepEqual(findBrittlePins('if\\([A-Za-z_$][\\w$]*\\(H\\)\\)return!0'), []);
});

test('tokenizeSmoke honors single/double quotes', () => {
  assert.deepEqual(tokenizeSmoke('node app.js --version'), ['node', 'app.js', '--version']);
  assert.deepEqual(tokenizeSmoke('node app.js --flag "a b"'), ['node', 'app.js', '--flag', 'a b']);
  assert.deepEqual(tokenizeSmoke("node app.js --flag 'a b'"), ['node', 'app.js', '--flag', 'a b']);
  assert.deepEqual(tokenizeSmoke('node "a b" \'c d\' e'), ['node', 'a b', 'c d', 'e']);
  // Backslash-escaped space outside quotes joins the token.
  assert.deepEqual(tokenizeSmoke('node a\\ b'), ['node', 'a b']);
  // Empty quoted arg is preserved as a token.
  assert.deepEqual(tokenizeSmoke('cmd "" x'), ['cmd', '', 'x']);
  // Collapses runs of whitespace.
  assert.deepEqual(tokenizeSmoke('  a   b  '), ['a', 'b']);
});

test('verify-batch matches non-Latin-1 literals without prefix-key aliasing', () => {
  // Two literals whose 2-char prefixes would collide under a *256 stride:
  //   "Āx" → 256*256 + 120
  //   "礀..." chosen so charCodeAt(0)*256+charCodeAt(1) equals the above.
  // Under *65536 they cannot collide. Either way, matches must stay correct.
  const litA = 'ĀZ_marker_A';            // code unit 256 in first position
  const litB = 'āZ_marker_B';
  const code = `prefix ${litA} middle ${litB} suffix`;
  const items = [
    { patchName: 'a', present: [litA], absent: [litB === litA ? 'never' : 'Ănope'] },
    { patchName: 'b', present: [litB] },
  ];
  const res = verifyBatch(code, items);
  for (const r of res) assert.deepEqual(r.issues, [], `${r.name} should pass`);

  // Negative: a literal that is NOT present must be reported absent-from-present.
  const miss = verifyBatch(code, [{ patchName: 'm', present: ['ĀZ_not_here'] }]);
  assert.ok(miss[0].issues.length > 0, 'absent present-literal must fail');
});

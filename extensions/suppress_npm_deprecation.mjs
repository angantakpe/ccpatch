/**
 * suppress_npm_deprecation — Hide the "switched from npm to native installer"
 * startup banner.
 *
 * Claude Code emits this warning when it detects it was installed via npm
 * rather than the native binary installer.  When running a ccpatch-patched
 * bundle the installer-type detection is meaningless — the bundle was
 * extracted and re-emitted by ccpatch, not by any installer.  The banner is
 * noise for all ccpatch users.
 *
 * The warning object in the bundle looks like:
 *   {id:"npm-deprecation",tier:"warning",type:"warning",
 *    isActive:(H)=>H.npmInstallDeprecated, render:...}
 *
 * We replace the isActive predicate with ()=>false so the warning is never
 * shown.  The anchor is the full id+tier+type+isActive prefix — unique in the
 * bundle and stable across minifier renaming (the string literals are fixed).
 *
 * v2.1.181: the predicate's parameter rotated from H to e
 * (isActive:(e)=>e.npmInstallDeprecated). Hard-coding the param `H` is the
 * minified-identifier mistake rule #1 forbids, so the param is now
 * regex-captured (\1 back-reference) and the verify literals are
 * param-independent.
 *
 * v2.1.238: the entire "npm-deprecation" warning system is gone from the
 * bundle — confirmed by grepping the extracted v2.1.238.cjs for the literal
 * substring "npm-deprecation" (zero occurrences, not just a reshaped pattern;
 * "native installer" appears exactly once elsewhere, in an unrelated
 * `claude doctor` symlink diagnostic, not this warning). Upstream apparently
 * removed the mechanism outright rather than reformatting it. Since there is
 * nothing left to suppress, this is a legitimate no-op, not drift — but a
 * verify.present patch that makes literally zero changes is fatal by default
 * (runner/apply-pipeline.mjs's no-change-is-fatal gate), which would hard-
 * block every future build until someone manually re-diagnoses this exact
 * same "it's just gone" finding. So: when the base marker is confirmed
 * absent, inject the shared idempotency SENTINEL as a standalone comment
 * (anchored on the CJS wrapper opener — the same stable literal
 * bin/extract-from-binary.mjs and react_singleton's fallback already anchor
 * on) instead of returning the code untouched. That turns a silent forever-
 * broken anchor into a real, inspectable "checked and confirmed gone" marker,
 * while a bundle where the marker EXISTS but the exact pattern doesn't match
 * (real, fixable drift) still hits the loud failure path — it does not fall
 * into this branch.
 */

// group 1 = the (minified) predicate parameter.
const ANCHOR_RE =
  /id:"npm-deprecation",tier:"warning",type:"warning",isActive:\(([A-Za-z_$][\w$]*)\)=>\1\.npmInstallDeprecated/;
const BASE_MARKER = 'id:"npm-deprecation"';
const SENTINEL = '__ccpNpmDeprecationSuppressed_v1';
const PATCHED =
  `id:"npm-deprecation",tier:"warning",type:"warning",isActive:()=>false/*${SENTINEL}*/`;
const ABSENT_UPSTREAM_COMMENT =
  `/*${SENTINEL}: npm-deprecation warning system not present in this bundle (removed upstream) — nothing to suppress*/`;
const CJS_WRAPPER_OPEN = '(function(exports, require, module, __filename, __dirname) {';

export default {
  category: 'fix',
  description: 'Suppress the "switched from npm to native installer" startup warning (irrelevant for patched bundles)',
  capabilities: [],
  verify: {
    // The shared sentinel — present whether the real predicate was patched
    // or the whole mechanism was confirmed absent upstream (see header).
    present: SENTINEL,
    count: { present: 1 },
  },
  apply: (code) => {
    if (code.includes(SENTINEL)) return code; // idempotent
    if (ANCHOR_RE.test(code)) {
      return code.replace(ANCHOR_RE, PATCHED);
    }
    if (!code.includes(BASE_MARKER)) {
      // Confirmed absent, not just reshaped — see the v2.1.238 header note.
      const wrapperIdx = code.indexOf(CJS_WRAPPER_OPEN);
      if (wrapperIdx !== -1) {
        console.warn('  [!] suppress_npm_deprecation: warning system not present in this bundle — nothing to suppress');
        const insertPoint = wrapperIdx + CJS_WRAPPER_OPEN.length;
        return code.slice(0, insertPoint) + '\n' + ABSENT_UPSTREAM_COMMENT + code.slice(insertPoint);
      }
    }
    // Base marker IS present but the full pattern doesn't match — real,
    // fixable drift. Stay loud and unpatched so the no-change gate fires.
    console.warn('  [!] suppress_npm_deprecation: anchor not found — warning not suppressed');
    return code;
  },
};

// runner/effective-apply.mjs — ONE definition of "the apply() this patch
// effectively runs with", shared by every probe surface.
//
// Three call sites used to hand-roll this synthesis: `ccpatch doctor`
// (runner/cli/cmd-doctor.mjs), the build-time pre-pass doctor
// (tools/anchor-doctor.mjs), and the patch-verification test layers. The
// build-time copy went stale when boot-only patches (bootInject with no
// apply()) were introduced, so every boot patch showed as MISSING "patch has
// no apply()" in the build's doctor table while applying fine. Centralising
// the synthesis makes that class of drift impossible.

import { compileKind } from './patch-kinds.mjs';
import { compileBootApply } from './boot-registry.mjs';

/**
 * Resolve the effective apply() for a patch:
 *   - hand-written apply()                          → as-is
 *   - declarative kind (prefix/postfix/transpiler)  → compileKind()
 *   - boot-only (bootInject, no apply())            → compileBootApply()
 *   - none of the above                             → null
 *
 * A compileKind() throw resolves to null (probe surfaces report it as
 * missing) rather than propagating — a malformed declarative patch must not
 * take down a doctor pass over the whole catalog.
 *
 * @param {object} patch  loaded patch module (default export)
 * @param {string} name   patch name (used in boot-splice warnings)
 * @returns {((code: string, options?: object) => string) | null}
 */
export function resolveEffectiveApply(patch, name) {
  if (!patch) return null;
  if (typeof patch.apply === 'function') return patch.apply;
  if (patch.kind && patch.kind !== 'free') {
    try { return compileKind(patch); } catch { return null; }
  }
  if (patch.bootInject) return compileBootApply(patch, name);
  return null;
}

/**
 * Probe-ready view of a patch: same object, but with the synthesized apply()
 * attached when the patch doesn't carry one. Patches that already have an
 * apply() (or where nothing can be synthesized) are returned unchanged, so
 * probeAnchor's "patch has no apply()" report still fires for genuinely
 * apply-less patches.
 *
 * @param {object} patch
 * @param {string} name
 * @returns {object}
 */
export function buildProbePatch(patch, name) {
  if (!patch || typeof patch.apply === 'function') return patch;
  const apply = resolveEffectiveApply(patch, name);
  return apply ? { ...patch, apply } : patch;
}

// `--profile=native` post-filter.
//
// The native profile produces a bundle that can be repacked into a Bun
// single-executable (SEA). Two patches are mechanically incompatible with
// that path:
//   - esm_compat   — rewrites the CJS IIFE wrapper to ESM, which Bun's SEA
//                    packer cannot re-bundle.
//   - fix_bun_shim — injects a Bun polyfill that conflicts with the runtime
//                    Bun already provides in the SEA host.
//
// Rather than make every consumer remember to exclude these, we drop them
// here whenever profile === 'native'. The build path logs a single
// "[native] auto-excluded …" line so users see what happened.

export const NATIVE_INCOMPATIBLE_PATCHES = Object.freeze(['esm_compat', 'fix_bun_shim']);

/**
 * Given the resolved list of patches to apply and the active profile name,
 * return a possibly-filtered list plus the names of any patches that were
 * dropped. When profile is anything other than "native", returns the input
 * unchanged.
 */
export function applyNativeProfileFilter(patchesToApply, profile) {
  if (profile !== 'native') {
    return { patches: patchesToApply, excluded: [] };
  }
  const drop = new Set(NATIVE_INCOMPATIBLE_PATCHES);
  const excluded = [];
  const kept = [];
  for (const name of patchesToApply) {
    if (drop.has(name)) excluded.push(name);
    else kept.push(name);
  }
  return { patches: kept, excluded };
}

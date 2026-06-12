/**
 * runner/boot-registry.mjs — the ONE owned boot-injection splice.
 *
 * Problem this replaces: N patches (bun_shim, fetch_interceptor, boot_banner,
 * stdin_da1_leak, mcp_lazy, tool_result_error_content, …) each independently
 * spliced boot-time code at the SAME canonical anchor (after a real leading
 * shebang, else around the CJS-IIFE head), every one with its own slightly
 * different match-and-replace. Their mutual overlaps were allowlisted noise,
 * and the effective execution order of the injected blocks was EMERGENT from
 * phase sort + application order rather than declared.
 *
 * The registry inverts that: a patch that needs code to run before the bundle
 * body declares it —
 *
 *   bootInject: {
 *     code: '<verbatim JS>'                 // or (options) => '<verbatim JS>'
 *     order: 20,                            // lower runs first; ties broken by
 *                                           // patch name (stable). Use gaps of
 *                                           // 10 so future hooks can slot in.
 *     sentinel: '__ccpMyHook',              // optional; defaults to the first
 *   }                                       // verify.present literal
 *
 * — and the runner collects all enabled patches' blocks, sorts them, joins
 * them with per-patch separators, and performs EXACTLY ONE insertion at the
 * canonical boot anchor (see spliceBoot in runner/patch-helpers.mjs for the
 * careful startsWith-vs-includes shebang reasoning).
 *
 * Idempotency contract (applying twice == applying once, byte-identical):
 *   - per patch: a patch whose sentinel is already present in the input is
 *     skipped (collectBootInjects → `skipped`).
 *   - registry-level: when every patch is skipped there are no entries and no
 *     splice happens at all, so no second BOOT_REGISTRY_SENTINEL block is ever
 *     inserted. A partial re-apply (some sentinels missing) injects ONLY the
 *     missing patches' blocks — per-patch idempotency is preserved.
 *
 * Failure mode (repo rule 4 — fail loud at apply time, never throw
 * mid-bundle): an anchor miss warns and returns the code unchanged; the
 * runner then records the affected patches as no-change so their
 * verify.present gate fails the build like any other anchor drift.
 *
 * The --require preload path (runner/preload-builder.mjs, consuming
 * `preload: true` + `preloadCode`) is untouched: the registry governs the
 * in-bundle splice only.
 */

import { spliceBoot } from './patch-helpers.mjs';
import { toList } from './verify-core.mjs';

/** Registry-level sentinel marking the combined boot block in output bundles. */
export const BOOT_REGISTRY_SENTINEL = '__ccpBootRegistry_v1';

/** Default order for bootInject blocks that don't declare one. */
const DEFAULT_BOOT_ORDER = 1000;

const RULE = '═'.repeat(74);

/**
 * Resolve the idempotency sentinel for a patch's bootInject block:
 * explicit `bootInject.sentinel`, else the first non-empty verify.present
 * literal (the convention every boot patch already follows), else null
 * (no skip detection possible — the block is always (re)injected).
 */
export function bootSentinelOf(patch) {
  const bi = patch?.bootInject;
  if (bi && typeof bi.sentinel === 'string' && bi.sentinel.length > 0) return bi.sentinel;
  const presents = toList(patch?.verify?.present);
  return presents.find((s) => typeof s === 'string' && s.length > 0) ?? null;
}

/**
 * Resolve a patch's boot code string. `bootInject.code` may be a verbatim
 * string or a function receiving the build options (mirroring how apply()
 * receives options.version — e.g. boot_banner stamps the version into its
 * box title). Throws on a non-string result so collectBootInjects can warn
 * per patch and skip it (fail loud, never half-apply).
 */
export function resolveBootCode(patch, name, options = {}) {
  const src = patch?.bootInject?.code;
  const code = typeof src === 'function' ? src(options) : src;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error(`bootInject.code for "${name}" must resolve to a non-empty string (got ${typeof code})`);
  }
  return code;
}

/**
 * Collect the bootInject blocks of all enabled patches, skipping patches
 * whose sentinel is already present in `code` (per-patch idempotency), and
 * sort by declared order (stable tiebreak by patch name).
 *
 * @param {Record<string, object>} patches  loaded patch map (name → module)
 * @param {string[]} names                  enabled patch names
 * @param {{ code: string, options?: object, logger?: object }} args
 * @returns {{ entries: Array<{name: string, order: number, code: string}>, skipped: string[] }}
 */
export function collectBootInjects(patches, names, { code, options = {}, logger = console } = {}) {
  const entries = [];
  const skipped = [];
  for (const name of names) {
    const patch = patches[name];
    if (!patch || !patch.bootInject) continue;
    const sentinel = bootSentinelOf(patch);
    if (sentinel && typeof code === 'string' && code.includes(sentinel)) {
      skipped.push(name);
      continue;
    }
    let blockCode;
    try {
      blockCode = resolveBootCode(patch, name, options);
    } catch (err) {
      logger.warn(`  [!] boot-registry: ${err.message} — skipping its boot hook`);
      continue;
    }
    const order = Number.isInteger(patch.bootInject.order)
      ? patch.bootInject.order
      : DEFAULT_BOOT_ORDER;
    entries.push({ name, order, code: blockCode });
  }
  entries.sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, skipped };
}

/**
 * Concatenate sorted entries into the single combined boot block, with a
 * registry header (carrying BOOT_REGISTRY_SENTINEL) and one clear
 * `// ── <patch>: boot hook ──` separator per patch. Hook payloads are
 * included verbatim — the registry changes the splice mechanics, never the
 * injected content.
 */
export function buildBootBlock(entries) {
  const parts = [
    '',
    `// ${RULE}`,
    `// [ccpatch boot registry] ${BOOT_REGISTRY_SENTINEL} — single owned boot splice.`,
    '// Hooks below run top-to-bottom in their declared bootInject.order, before',
    '// the bundle body. See runner/boot-registry.mjs.',
    `// ${RULE}`,
    '',
  ];
  for (const e of entries) {
    parts.push(`// ── ${e.name}: boot hook (order ${e.order}) ──`);
    parts.push(e.code);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Perform the single boot splice for the collected entries. No entries → the
 * code is returned untouched (this is what makes a full re-apply a byte-
 * identical no-op). An anchor miss (neither a real leading shebang nor the
 * CJS-IIFE head) warns loudly and returns the code unchanged — never throws
 * mid-bundle.
 *
 * @returns {string} the spliced code, or the input unchanged on miss/empty
 */
export function spliceBootRegistry(code, entries, logger = console) {
  if (!Array.isArray(entries) || entries.length === 0) return code;
  const block = buildBootBlock(entries);
  try {
    return spliceBoot(code, block);
  } catch (err) {
    logger.warn(
      `  [!] boot-registry: ${err.message} — boot hooks NOT injected ` +
      `(${entries.map((e) => e.name).join(', ')})`,
    );
    return code;
  }
}

/**
 * Synthesize a standalone apply() for ONE bootInject patch — used by
 * `ccpatch doctor` (probeAnchor needs a real fn) and the patch-verification
 * test layers, NOT by the build runner (which performs the single combined
 * splice via spliceBootRegistry). Sentinel-guarded, warn-and-return on
 * anchor miss: same contracts as a hand-written boot apply().
 */
export function compileBootApply(patch, name) {
  return (code, options = {}) => {
    const sentinel = bootSentinelOf(patch);
    if (sentinel && code.includes(sentinel)) return code;
    let resolved;
    try {
      resolved = resolveBootCode(patch, name, options);
    } catch (err) {
      console.warn(`  [!] ${name}: ${err.message}`);
      return code;
    }
    const order = Number.isInteger(patch.bootInject.order)
      ? patch.bootInject.order
      : DEFAULT_BOOT_ORDER;
    try {
      return spliceBoot(code, buildBootBlock([{ name, order, code: resolved }]));
    } catch (err) {
      console.warn(`  [!] ${name}: ${err.message} — boot hook not injected`);
      return code;
    }
  };
}

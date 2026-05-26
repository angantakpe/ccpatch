/**
 * Patch type definitions for ccpatch.
 *
 * SOURCE OF TRUTH: runner/manifest.mjs (the validateManifest() function).
 * This file is hand-mirrored from the validator to give patch authors editor
 * type-hints without introducing a TypeScript build step. If you change
 * manifest.mjs you MUST update this file (and vice-versa).
 *
 * CI guard: `npm run gen:types -- --check` re-runs scripts/gen-types.mjs and
 * fails if this file drifts from the validator's `CAPABILITIES` / kind / phase
 * enums.
 *
 * Usage in a patch file:
 *   /** @type {import('../types/patch').Patch} *\/
 *   export default {
 *     description: '…',
 *     verify: { present: '…' },
 *     apply(code) { return code; },
 *   };
 */

// ── Enums (mirror runner/manifest.mjs + at-selector.mjs + patch-kinds.mjs) ──

/** Declared runtime powers — see THREAT_MODEL.md. */
export type Capability =
  | 'network'
  | 'fs'
  | 'prompt'
  | 'tools'
  | 'env'
  | 'exec'
  | 'telemetry';

/** Risk classification derived from `capabilities`. */
export type Risk = 'low' | 'medium' | 'high';

/** Build phase. Patches run pre → main → post. */
export type Phase = 'pre' | 'main' | 'post';

/** Patch category — informational, used by reporters. */
export type Category =
  | 'infrastructure'
  | 'fix'
  | 'feature'
  | 'observe'
  | 'expose'
  | 'optional';

/** Apply mode — 'build' runs at bundle build time, 'either' may also run at runtime. */
export type ApplyMode = 'build' | 'either';

/** Declarative patch shape. 'free' is the apply()-escape-hatch default. */
export type Kind = 'free' | 'prefix' | 'postfix' | 'transpiler';

/** @At selector kinds. See runner/at-selector.mjs. */
export type AtKind = 'HEAD' | 'RETURN' | 'INVOKE' | 'BEFORE' | 'AFTER';

// ── Sub-shapes ─────────────────────────────────────────────────────────────

/** Function-spec: name or stable string literal anchor. */
export type FunctionSpec =
  | string
  | { literal: string }
  | { name: string }
  | { body: string };

/** Post-apply assertion. At least one of present/absent/count is required. */
export interface VerifyBlock {
  /** Substring(s) that MUST exist post-apply. */
  present?: string | string[];
  /** Substring(s) that MUST NOT exist post-apply. */
  absent?: string | string[];
  /** Exact occurrence count. Number → present count; object → fine-grained. */
  count?: number | { present?: number; absent?: number };
  /**
   * Opt-in for present-only verifies. Present-only verifies cannot detect
   * wrong-location apply or double-apply; set weak:true to acknowledge.
   */
  weak?: boolean;
  /** Optional human label used in failure messages. */
  label?: string;
}

/** Patch-package style unified diff used when apply() returns no change. */
export interface FallbackDiff {
  /** Unified-diff text (patch-package style). */
  patch: string;
  /** CC version the diff was captured against (informational). */
  capturedAgainst: string;
  /** applyPatch fuzzFactor (default 3). */
  fuzz?: number;
}

/** Lifecycle hook context. */
export interface LifecycleCtx {
  name: string;
  phase: Phase;
  code: string;
  appliedCode: string;
  opts: Record<string, unknown>;
  verify: VerifyBlock | null;
  attempt: number;
  logger: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

/** Lifecycle hook function (sync or async). */
export type LifecycleHook = (ctx: LifecycleCtx) => void | string | Promise<void | string>;

/** Marker for patches that should be re-evaluated as upstream evolves. */
export interface Revisit {
  note: string;
  addedIn?: string;
  until?: string;
}

/** Marks patch as no-longer-needed. */
export interface Deprecated {
  reason: string;
  since?: string;
}

/** Magisk-style sibling-file shim. */
export interface Overlay {
  register: string;
  code: string;
}

/** Literal anchor (legacy; prefer `at:` selector). */
export interface Anchor {
  literal: string;
  byteOffset?: number;
}

/** @At selector — declarative anchor. */
export interface AtSelector {
  kind: AtKind;
  target: {
    function?: FunctionSpec;
    call?: FunctionSpec;
    in?: FunctionSpec;
    literal?: string;
    occurrence?: number;
  };
}

/** Target for declarative (non-free) kinds. */
export interface KindTarget {
  function: FunctionSpec;
}

// ── Main Patch interface ───────────────────────────────────────────────────

/**
 * A ccpatch patch module's `default` export.
 *
 * Required: `description`, `verify`, and either `apply` (for kind='free') or
 * `target` + `code`/`transform` (for declarative kinds).
 */
export interface Patch {
  // ── Required ──
  description: string;
  verify: VerifyBlock;

  // ── Declarative kind / free-form apply ──
  /** Patch shape. Default 'free' (uses apply()). */
  kind?: Kind;
  /** Required when kind != 'free'. */
  target?: KindTarget;
  /** Required when kind = 'prefix' or 'postfix'. Verbatim JS to inject. */
  code?: string;
  /** Required when kind = 'transpiler'. */
  transform?: (functionBody: string, opts: Record<string, unknown>) => string;
  /** Free-form apply(). Required when kind = 'free' (or unset). */
  apply?: (code: string, opts?: Record<string, unknown>) => string;

  // ── Recommended ──
  category?: Category;
  /** Default-enabled hint; ccpatch.yml is authoritative. */
  enabled?: boolean;
  /** Declared runtime powers. */
  capabilities?: Capability[];

  // ── Identity / docs ──
  name?: string;
  version?: string;
  tags?: string[];
  /** Env vars this patch reads (documentation only). */
  env?: string[];

  // ── Scheduling ──
  applyMode?: ApplyMode;
  phase?: Phase;
  /** Lower runs first within a phase (default 1000). */
  priority?: number;
  dependsOn?: string[];
  /** Acknowledged overlapping peers. */
  allowOverlapWith?: string[];

  // ── Anchoring ──
  anchor?: Anchor;
  at?: AtSelector;

  // ── Robustness ──
  /** When true, no-change / verify-fail / apply-error makes the build fail. */
  required?: boolean;
  /** Substrings that must NOT appear in the patched bundle (dry-run check). */
  forbiddenAfterPatch?: string[];
  fallbackDiff?: FallbackDiff;
  /** CC versions this patch was validated against. */
  testedAgainst?: string[];

  // ── Lifecycle hooks ──
  onBeforeApply?: LifecycleHook;
  onAfterApply?: LifecycleHook;
  onVerifyFail?: LifecycleHook;

  // ── Preload (--require) variant ──
  preload?: boolean;
  preloadCode?: string;

  // ── Overlay (sibling-file shim) ──
  overlay?: Overlay;

  // ── Status markers ──
  deprecated?: Deprecated;
  revisit?: Revisit;

  // ── Coverage ──
  /** Opt-in runtime coverage marker. */
  coverageMarker?: string;
}

/** Normalized form returned by validateManifest(). */
export interface NormalizedPatch {
  name: string;
  version: string;
  description: string;
  category: Category | null;
  enabled: boolean;
  env: string[];
  tags: string[];
  dependsOn: string[];
  phase: Phase;
  applyMode: ApplyMode;
  anchor: Anchor | null;
  apply: ((code: string, opts?: Record<string, unknown>) => string) | null;
  preload: boolean;
  preloadCode: string | null;
  verify: VerifyBlock | null;
  required: boolean;
  deprecated: Deprecated | null;
  revisit: Revisit | null;
  forbiddenAfterPatch: string[];
  fallbackDiff: FallbackDiff | null;
  testedAgainst: string[] | null;
  resolvedVariant: string;
  capabilities: Capability[];
  risk: Risk;
  priority: number;
  allowOverlapWith: string[];
  at: AtSelector | null;
  kind: Kind;
  target: KindTarget | null;
  code: string | null;
  overlay: Overlay | null;
  transform: ((functionBody: string, opts: Record<string, unknown>) => string) | null;
  coverageMarker: string | null;
}

/** Result of validateManifest(). */
export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  normalized: NormalizedPatch;
}

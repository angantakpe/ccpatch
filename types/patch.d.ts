/**
 * Patch type definitions for ccpatch.
 *
 * GENERATED FILE — do not edit by hand.
 * SOURCE OF TRUTH: runner/manifest-schema.mjs
 * Regenerate with: npm run gen:types -- --write
 *
 * The same schema drives validateManifest() in runner/manifest.mjs at runtime,
 * so this surface and the validator cannot drift. CI guard: `npm run gen:types`
 * (and `npm run lint:types`) re-runs this generator in --check mode.
 *
 * Usage in a patch file:
 *   /** @type {import('../types/patch').Patch} *\/
 *   export default {
 *     description: '…',
 *     verify: { present: '…' },
 *     apply(code) { return code; },
 *   };
 */

// ── Enums (generated from runner/manifest-schema.mjs) ──

/**
 * - network: patch intercepts fetch / makes outbound requests
 * - fs: patch reads/writes files outside the bundle
 * - prompt: patch modifies system or user prompt content
 * - tools: patch alters tool dispatch or tool definitions
 * - env: patch reads env vars (beyond documented `env` field)
 * - exec: patch can execute subprocesses
 * - telemetry: patch sends data to external sinks (webhook, logging service)
 */
export type Capability =
  | 'network'
  | 'fs'
  | 'prompt'
  | 'tools'
  | 'env'
  | 'exec'
  | 'telemetry';

export type Risk =
  | 'low'
  | 'medium'
  | 'high';

export type Phase =
  | 'pre'
  | 'main'
  | 'post';

export type Category =
  | 'infrastructure'
  | 'fix'
  | 'feature'
  | 'observe'
  | 'expose'
  | 'optional';

export type ApplyMode =
  | 'build'
  | 'either';

export type Kind =
  | 'free'
  | 'prefix'
  | 'postfix'
  | 'transpiler';

export type AtKind =
  | 'HEAD'
  | 'RETURN'
  | 'INVOKE'
  | 'BEFORE'
  | 'AFTER';

// ── Sub-shapes ──

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
  /** Opt-in for present-only verifies (cannot detect wrong-location / double apply). */
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

/** Marks patch as no-longer-needed. `removeAfter` arms the retirement nudge. */
export interface Deprecated {
  reason: string;
  /** CC version the patch became unnecessary (e.g. flag removed upstream). */
  since?: string;
  /** CC version past which the patch should be deleted; building against >= this emits a [deprecated] retirement warning. */
  removeAfter?: string;
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
  /** When true, regex anchors are permitted for this patch. Requires maintainer approval. */
  allowRegex?: boolean;
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

/** Declarative boot hook — spliced ONCE by the runner boot registry (runner/boot-registry.mjs) at the canonical boot anchor. */
export interface BootInject {
  /** Verbatim JS to run before the bundle body (or a builder receiving the build options). */
  code: string | ((options: Record<string, unknown>) => string);
  /** Lower runs first; ties broken by patch name. Use gaps of 10. Default 1000. */
  order?: number;
  /** Idempotency marker; defaults to the first verify.present literal. */
  sentinel?: string;
}

// ── Main Patch interface ──

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
  /** Free-form apply(). Required when kind = 'free' (or unset), unless bootInject is declared. */
  apply?: (code: string, opts?: Record<string, unknown>) => string;
  /** Declarative boot hook; the runner boot registry performs ONE combined splice for all enabled patches. */
  bootInject?: BootInject;

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
  bootInject: BootInject | null;
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

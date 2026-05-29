/**
 * manifest-schema.mjs — the SINGLE declarative source of truth for the patch
 * manifest contract.
 *
 * This dependency-free module replaces the previous arrangement where the type
 * contract lived in three places that could silently drift:
 *   1. runner/manifest.mjs       — the runtime validator (hand-coded enums)
 *   2. types/patch.d.ts          — hand-mirrored TypeScript surface
 *   3. scripts/gen-types.mjs     — a regex-based drift *detector*
 *
 * Now there is ONE schema:
 *   (a) validateManifest (runner/manifest.mjs) imports the enum sets from here
 *       and drives its enum/type checks off them.
 *   (b) scripts/gen-types.mjs walks the SCHEMA below to *generate* the entire
 *       types/patch.d.ts (enums + Patch + NormalizedPatch + sub-shapes), so the
 *       .d.ts is emitted, not policed.
 *
 * The many bespoke validations (weak-verify guard, at-selector shape,
 * kind/target coupling, fallbackDiff, testedAgainst variant matching, …) are
 * not expressible as flat field rules, so they stay in validateManifest. The
 * schema's job is to (1) own the enum vocabularies and (2) describe the
 * documented type surface for the generated .d.ts.
 *
 * Keep this module free of imports from the rest of the runner so both the
 * validator and the (Node-only) type generator can load it cheaply.
 */

// ── Enum vocabularies (the runtime-enforced sets) ───────────────────────────
// Each entry is { value, doc? } so the type emitter can attach a comment.

/** Declared runtime powers — see THREAT_MODEL.md. */
export const CAPABILITY_ENUM = Object.freeze([
  { value: 'network',   doc: 'patch intercepts fetch / makes outbound requests' },
  { value: 'fs',        doc: 'patch reads/writes files outside the bundle' },
  { value: 'prompt',    doc: 'patch modifies system or user prompt content' },
  { value: 'tools',     doc: 'patch alters tool dispatch or tool definitions' },
  { value: 'env',       doc: 'patch reads env vars (beyond documented `env` field)' },
  { value: 'exec',      doc: 'patch can execute subprocesses' },
  { value: 'telemetry', doc: 'patch sends data to external sinks (webhook, logging service)' },
]);

/** Build phase. Patches run pre → main → post. */
export const PHASE_ENUM = Object.freeze([
  { value: 'pre' }, { value: 'main' }, { value: 'post' },
]);

/** Patch category — informational, used by reporters. */
export const CATEGORY_ENUM = Object.freeze([
  { value: 'infrastructure' }, { value: 'fix' }, { value: 'feature' },
  { value: 'observe' }, { value: 'expose' }, { value: 'optional' },
]);

/** Apply mode — 'build' runs at bundle build time, 'either' may also run at runtime. */
export const APPLY_MODE_ENUM = Object.freeze([
  { value: 'build' }, { value: 'either' },
]);

/** Declarative patch shape. 'free' is the apply()-escape-hatch default. */
export const KIND_ENUM = Object.freeze([
  { value: 'free' }, { value: 'prefix' }, { value: 'postfix' }, { value: 'transpiler' },
]);

/** @At selector kinds. See runner/at-selector.mjs. */
export const AT_KIND_ENUM = Object.freeze([
  { value: 'HEAD' }, { value: 'RETURN' }, { value: 'INVOKE' },
  { value: 'BEFORE' }, { value: 'AFTER' },
]);

/** Risk classification derived from `capabilities` (not user-settable). */
export const RISK_ENUM = Object.freeze([
  { value: 'low' }, { value: 'medium' }, { value: 'high' },
]);

/** All named enums, keyed by the TypeScript type name the emitter should produce. */
export const ENUMS = Object.freeze({
  Capability: CAPABILITY_ENUM,
  Risk:       RISK_ENUM,
  Phase:      PHASE_ENUM,
  Category:   CATEGORY_ENUM,
  ApplyMode:  APPLY_MODE_ENUM,
  Kind:       KIND_ENUM,
  AtKind:     AT_KIND_ENUM,
});

/** Convenience: bare value arrays + ready-made Sets for the validator. */
export const enumValues = (e) => e.map((x) => x.value);
export const CAPABILITIES_LIST = Object.freeze(enumValues(CAPABILITY_ENUM));
export const PHASES_LIST        = Object.freeze(enumValues(PHASE_ENUM));
export const CATEGORIES_LIST    = Object.freeze(enumValues(CATEGORY_ENUM));
export const APPLY_MODES_LIST   = Object.freeze(enumValues(APPLY_MODE_ENUM));
export const KINDS_LIST         = Object.freeze(enumValues(KIND_ENUM));
export const AT_KINDS_LIST      = Object.freeze(enumValues(AT_KIND_ENUM));

// ── Shared sub-shapes (interfaces / type aliases emitted before Patch) ───────
// Each is a raw TS body the emitter wraps. Kept verbatim because they encode
// hand-tuned union shapes (FunctionSpec, LifecycleCtx) that are not produced
// from field descriptors.

export const TYPE_ALIASES = Object.freeze([
  {
    name: 'FunctionSpec',
    doc: 'Function-spec: name or stable string literal anchor.',
    body: `  | string\n  | { literal: string }\n  | { name: string }\n  | { body: string }`,
  },
  {
    name: 'LifecycleHook',
    doc: 'Lifecycle hook function (sync or async).',
    body: `(ctx: LifecycleCtx) => void | string | Promise<void | string>`,
  },
]);

export const INTERFACES = Object.freeze([
  {
    name: 'VerifyBlock',
    doc: 'Post-apply assertion. At least one of present/absent/count is required.',
    fields: [
      { name: 'present?', type: 'string | string[]', doc: 'Substring(s) that MUST exist post-apply.' },
      { name: 'absent?',  type: 'string | string[]', doc: 'Substring(s) that MUST NOT exist post-apply.' },
      { name: 'count?',   type: 'number | { present?: number; absent?: number }', doc: 'Exact occurrence count. Number → present count; object → fine-grained.' },
      { name: 'weak?',    type: 'boolean', doc: 'Opt-in for present-only verifies (cannot detect wrong-location / double apply).' },
      { name: 'label?',   type: 'string', doc: 'Optional human label used in failure messages.' },
    ],
  },
  {
    name: 'FallbackDiff',
    doc: 'Patch-package style unified diff used when apply() returns no change.',
    fields: [
      { name: 'patch',           type: 'string', doc: 'Unified-diff text (patch-package style).' },
      { name: 'capturedAgainst', type: 'string', doc: 'CC version the diff was captured against (informational).' },
      { name: 'fuzz?',           type: 'number', doc: 'applyPatch fuzzFactor (default 3).' },
    ],
  },
  {
    name: 'LifecycleCtx',
    doc: 'Lifecycle hook context.',
    fields: [
      { name: 'name',        type: 'string' },
      { name: 'phase',       type: 'Phase' },
      { name: 'code',        type: 'string' },
      { name: 'appliedCode', type: 'string' },
      { name: 'opts',        type: 'Record<string, unknown>' },
      { name: 'verify',      type: 'VerifyBlock | null' },
      { name: 'attempt',     type: 'number' },
      { name: 'logger',      type: '{ log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }' },
    ],
  },
  {
    name: 'Revisit',
    doc: 'Marker for patches that should be re-evaluated as upstream evolves.',
    fields: [
      { name: 'note',     type: 'string' },
      { name: 'addedIn?', type: 'string' },
      { name: 'until?',   type: 'string' },
    ],
  },
  {
    name: 'Deprecated',
    doc: 'Marks patch as no-longer-needed.',
    fields: [
      { name: 'reason',  type: 'string' },
      { name: 'since?',  type: 'string' },
    ],
  },
  {
    name: 'Overlay',
    doc: 'Magisk-style sibling-file shim.',
    fields: [
      { name: 'register', type: 'string' },
      { name: 'code',     type: 'string' },
    ],
  },
  {
    name: 'Anchor',
    doc: 'Literal anchor (legacy; prefer `at:` selector).',
    fields: [
      { name: 'literal',     type: 'string' },
      { name: 'byteOffset?', type: 'number' },
    ],
  },
  {
    name: 'AtSelector',
    doc: '@At selector — declarative anchor.',
    fields: [
      { name: 'kind',   type: 'AtKind' },
      { name: 'target', type: '{\n    function?: FunctionSpec;\n    call?: FunctionSpec;\n    in?: FunctionSpec;\n    literal?: string;\n    occurrence?: number;\n  }' },
    ],
  },
  {
    name: 'KindTarget',
    doc: 'Target for declarative (non-free) kinds.',
    fields: [
      { name: 'function', type: 'FunctionSpec' },
    ],
  },
]);

// ── The Patch interface (author-facing) ─────────────────────────────────────
// Grouped sections preserve the documented layout of the .d.ts. Each field:
//   { name, type, doc?, section? }
// `section` (optional) emits a `// ── <section> ──` banner before the field.

export const PATCH_FIELDS = Object.freeze([
  { section: 'Required', name: 'description', type: 'string' },
  { name: 'verify', type: 'VerifyBlock' },

  { section: 'Declarative kind / free-form apply', name: 'kind?', type: 'Kind', doc: "Patch shape. Default 'free' (uses apply())." },
  { name: 'target?', type: 'KindTarget', doc: "Required when kind != 'free'." },
  { name: 'code?', type: 'string', doc: "Required when kind = 'prefix' or 'postfix'. Verbatim JS to inject." },
  { name: 'transform?', type: '(functionBody: string, opts: Record<string, unknown>) => string', doc: "Required when kind = 'transpiler'." },
  { name: 'apply?', type: '(code: string, opts?: Record<string, unknown>) => string', doc: "Free-form apply(). Required when kind = 'free' (or unset)." },

  { section: 'Recommended', name: 'category?', type: 'Category' },
  { name: 'enabled?', type: 'boolean', doc: 'Default-enabled hint; ccpatch.yml is authoritative.' },
  { name: 'capabilities?', type: 'Capability[]', doc: 'Declared runtime powers.' },

  { section: 'Identity / docs', name: 'name?', type: 'string' },
  { name: 'version?', type: 'string' },
  { name: 'tags?', type: 'string[]' },
  { name: 'env?', type: 'string[]', doc: 'Env vars this patch reads (documentation only).' },

  { section: 'Scheduling', name: 'applyMode?', type: 'ApplyMode' },
  { name: 'phase?', type: 'Phase' },
  { name: 'priority?', type: 'number', doc: 'Lower runs first within a phase (default 1000).' },
  { name: 'dependsOn?', type: 'string[]' },
  { name: 'allowOverlapWith?', type: 'string[]', doc: 'Acknowledged overlapping peers.' },

  { section: 'Anchoring', name: 'anchor?', type: 'Anchor' },
  { name: 'at?', type: 'AtSelector' },

  { section: 'Robustness', name: 'required?', type: 'boolean', doc: 'When true, no-change / verify-fail / apply-error makes the build fail.' },
  { name: 'forbiddenAfterPatch?', type: 'string[]', doc: 'Substrings that must NOT appear in the patched bundle (dry-run check).' },
  { name: 'fallbackDiff?', type: 'FallbackDiff' },
  { name: 'testedAgainst?', type: 'string[]', doc: 'CC versions this patch was validated against.' },

  { section: 'Lifecycle hooks', name: 'onBeforeApply?', type: 'LifecycleHook' },
  { name: 'onAfterApply?', type: 'LifecycleHook' },
  { name: 'onVerifyFail?', type: 'LifecycleHook' },

  { section: 'Preload (--require) variant', name: 'preload?', type: 'boolean' },
  { name: 'preloadCode?', type: 'string' },

  { section: 'Overlay (sibling-file shim)', name: 'overlay?', type: 'Overlay' },

  { section: 'Status markers', name: 'deprecated?', type: 'Deprecated' },
  { name: 'revisit?', type: 'Revisit' },

  { section: 'Coverage', name: 'coverageMarker?', type: 'string', doc: 'Opt-in runtime coverage marker.' },
]);

// ── Teaching hints for validateManifest rejections (U3) ──────────────────────
// A single declarative source for the *guidance* half of a rejection message:
// each field's expected shape plus a one-line correct example. validateManifest
// imports these and interpolates them so the error TEACHES (field name + shape +
// example), matching the quality bar of the dependsOn errors in runner.mjs.
//
// Keyed by the field/path the validator reports on. Each descriptor:
//   { shape: string, example: string }
//     shape   — the expected type/shape, in the same vocabulary the docs use.
//     example — a one-line, copy-pasteable correct value.
// Drive the message text through fieldHint()/missingField() below so the wording
// (and the example) lives in ONE place and cannot drift across call sites.
export const FIELD_HINTS = Object.freeze({
  description:  { shape: 'string', example: "description: 'Force the thinking feature flag on'" },
  verify:       { shape: '{ present?, absent?, count?, weak? }', example: "verify: { present: '__marker__', absent: '__marker____marker__' }" },
  'verify.count': { shape: 'number | { present?: number, absent?: number }', example: 'verify: { count: { present: 1 } }' },
  'verify.weak':  { shape: 'boolean', example: 'verify: { present: \'__m__\', weak: true }' },
  overlay:      { shape: '{ register: string, code: string }', example: "overlay: { register: 'sidecar.mjs', code: 'export const x = 1;' }" },
  category:     { shape: `one of ${CATEGORIES_LIST.join(' | ')}`, example: "category: 'feature'" },
  enabled:      { shape: 'boolean', example: 'enabled: false' },
  required:     { shape: 'boolean', example: 'required: true' },
  name:         { shape: 'string (must equal the filename stem)', example: "name: 'force_thinking'  // in force_thinking.mjs" },
  applyMode:    { shape: `one of ${APPLY_MODES_LIST.join(' | ')}`, example: "applyMode: 'build'" },
  kind:         { shape: `one of ${KINDS_LIST.join(' | ')}`, example: "kind: 'prefix'" },
  'target.function': { shape: "{ literal: 'STABLE_SUBSTR' } | 'functionName'", example: "target: { function: { literal: 'alwaysThinkingEnabled' } }" },
  code:         { shape: 'string (verbatim JS to inject)', example: "code: 'console.log(\"entered\");'" },
  transform:    { shape: '(functionBody: string, opts) => string', example: 'transform: (body) => body.replace(/return!1/, \'return!0\')' },
  anchor:       { shape: '{ literal: string, byteOffset?: number }', example: "anchor: { literal: 'STABLE_SUBSTR' }" },
  at:           { shape: '{ kind, target }', example: "at: { kind: 'HEAD', target: { function: 'foo' } }" },
  'at.kind':    { shape: `one of ${AT_KINDS_LIST.join(' | ')}`, example: "at: { kind: 'INVOKE', target: { call: 'fetch' } }" },
  dependsOn:    { shape: 'string[] (other patch names)', example: "dependsOn: ['expose_agent_tool']" },
  phase:        { shape: `one of ${PHASES_LIST.join(' | ')}`, example: "phase: 'pre'" },
  priority:     { shape: 'finite integer (lower runs first; default 1000)', example: 'priority: 500' },
  allowOverlapWith: { shape: 'string[] of non-empty patch names', example: "allowOverlapWith: ['other_patch']" },
  capabilities: { shape: `string[] — any of ${CAPABILITIES_LIST.join(' | ')}`, example: "capabilities: ['prompt', 'fs']" },
  fallbackDiff: { shape: '{ patch: string, capturedAgainst: string, fuzz?: number }', example: "fallbackDiff: { patch: '--- a\\n+++ b\\n…', capturedAgainst: '2.1.156' }" },
  forbiddenAfterPatch: { shape: 'string[] of non-empty strings', example: "forbiddenAfterPatch: ['debugger', 'console.log']" },
  coverageMarker: { shape: 'non-empty string', example: "coverageMarker: 'force_thinking_hit'" },
  deprecated:   { shape: '{ reason: string, since?: string }', example: "deprecated: { reason: 'upstream fixed in 2.1.146', since: '2.1.146' }" },
  revisit:      { shape: '{ note: string, addedIn?: string, until?: string }', example: "revisit: { note: 'recheck when flag stabilizes', until: '2.2.0' }" },
  testedAgainst: { shape: 'non-empty string[] of versions/ranges', example: "testedAgainst: ['2.1.156', '>=2.1.150']" },
});

/**
 * Format a teaching rejection for a malformed field. Produces:
 *   `<field> must be <shape> — e.g. <example>`
 * `detail` (optional) is appended before the example to explain the specific
 * problem (e.g. which sub-field is wrong). Driven by FIELD_HINTS so the shape +
 * example are defined once.
 */
export function fieldHint(field, detail) {
  const h = FIELD_HINTS[field];
  const shape = h ? h.shape : 'a valid value';
  // A detail that begins with a sub-field accessor (".reason", ".patch") joins
  // without a space so the message reads "deprecated.reason …" (a single token
  // authors can grep for); otherwise insert a space ("verify must specify …").
  const sep = detail && detail.startsWith('.') ? '' : ' ';
  const lead = detail ? `${field}${sep}${detail}` : `${field} must be ${shape}`;
  return h ? `${lead} — e.g. ${h.example}` : lead;
}

/**
 * Format a teaching rejection for a *missing required* field. Produces:
 *   `missing required field: <field> (<shape>) — e.g. <example>`
 */
export function missingField(field, detail) {
  const h = FIELD_HINTS[field];
  const shape = h ? h.shape : 'required';
  const lead = detail
    ? `missing required field: ${field} — ${detail}`
    : `missing required field: ${field} (${shape})`;
  return h ? `${lead} — e.g. ${h.example}` : lead;
}

// ── The NormalizedPatch interface (validateManifest output) ──────────────────

export const NORMALIZED_FIELDS = Object.freeze([
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'category', type: 'Category | null' },
  { name: 'enabled', type: 'boolean' },
  { name: 'env', type: 'string[]' },
  { name: 'tags', type: 'string[]' },
  { name: 'dependsOn', type: 'string[]' },
  { name: 'phase', type: 'Phase' },
  { name: 'applyMode', type: 'ApplyMode' },
  { name: 'anchor', type: 'Anchor | null' },
  { name: 'apply', type: '((code: string, opts?: Record<string, unknown>) => string) | null' },
  { name: 'preload', type: 'boolean' },
  { name: 'preloadCode', type: 'string | null' },
  { name: 'verify', type: 'VerifyBlock | null' },
  { name: 'required', type: 'boolean' },
  { name: 'deprecated', type: 'Deprecated | null' },
  { name: 'revisit', type: 'Revisit | null' },
  { name: 'forbiddenAfterPatch', type: 'string[]' },
  { name: 'fallbackDiff', type: 'FallbackDiff | null' },
  { name: 'testedAgainst', type: 'string[] | null' },
  { name: 'resolvedVariant', type: 'string' },
  { name: 'capabilities', type: 'Capability[]' },
  { name: 'risk', type: 'Risk' },
  { name: 'priority', type: 'number' },
  { name: 'allowOverlapWith', type: 'string[]' },
  { name: 'at', type: 'AtSelector | null' },
  { name: 'kind', type: 'Kind' },
  { name: 'target', type: 'KindTarget | null' },
  { name: 'code', type: 'string | null' },
  { name: 'overlay', type: 'Overlay | null' },
  { name: 'transform', type: '((functionBody: string, opts: Record<string, unknown>) => string) | null' },
  { name: 'coverageMarker', type: 'string | null' },
]);

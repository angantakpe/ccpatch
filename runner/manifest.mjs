/**
 * Patch manifest validator.
 * Usage: validateManifest(mod, filename) → { ok, errors, normalized }
 *
 * Required fields:
 *   description  string    One-line description shown in build output.
 *   apply        function  (code: string, opts?) => string  (unless applyMode='runtime')
 *
 * Recommended fields:
 *   category     string    One of: infrastructure | fix | feature | observe | expose | optional
 *   enabled      boolean   Default enabled state hint (YAML ccpatch.yml is authoritative).
 *
 * Required:
 *   verify       object    { present?: string|string[],
 *                            absent?:  string|string[],
 *                            count?:   number | { present?: number, absent?: number },
 *                            weak?:    boolean }
 *                          Post-apply assertion. At least one of present/absent/count required.
 *                          - present: substrings that MUST exist post-apply.
 *                          - absent:  substrings that MUST NOT exist post-apply (catches
 *                                     no-op apply + double-apply).
 *                          - count:   exact occurrence totals. Shorthand number => present count.
 *                                     Object => fine-grained { present, absent } counts.
 *                          - weak:    boolean opt-in. When verify only declares `present`
 *                                     (no absent/count), validation errors out — set
 *                                     weak:true to acknowledge that the verify cannot
 *                                     detect wrong-location apply / double apply.
 *
 * Optional top-level:
 *   deprecated   object    { reason: string, since?: string, removeAfter?: string }
 *                          Marks the patch as deprecated. Reporters render the patch
 *                          row with a "deprecated" status (not "ok") and surface
 *                          `reason` in the detail column. `since` is informational
 *                          (e.g. CC version that removed the underlying feature).
 *                          `removeAfter` arms the retirement lifecycle: building
 *                          against a CC version >= removeAfter emits a [deprecated]
 *                          warning ("scheduled for removal after <ver>; remove it"),
 *                          fatal only under --strict. See deprecationWarning() below.
 *
 * Optional fields:
 *   bootInject   object    { code: string | (options) => string, order?: int, sentinel?: string }
 *                          Declarative boot hook. The runner's boot registry
 *                          (runner/boot-registry.mjs) collects all enabled patches'
 *                          blocks, sorts by `order` (ties broken by patch name) and
 *                          performs EXACTLY ONE splice at the canonical boot anchor
 *                          (after a real leading shebang, else before the CJS-IIFE
 *                          head). `sentinel` defaults to the first verify.present
 *                          literal and gates idempotent re-application. A patch may
 *                          be boot-only (bootInject with no apply()) or combine
 *                          bootInject with an apply() for non-boot transformations.
 *   name         string    Must match the filename stem if provided.
 *   version      string    Semver e.g. "1.0.0" (default "0.0.0").
 *   applyMode    string    'build' | 'either'  (default 'build').
 *   anchor       object    { literal: string, byteOffset?: number }
 *   dependsOn    string[]  Other patch names this must run after.
 *   phase        string    'pre' | 'main' | 'post' (default 'main'). Phases run in order:
 *                          pre → main → post. Within a phase, topoSort by dependsOn applies.
 *                          A patch's dependsOn must point to same-or-earlier phase, else error.
 *   env          string[]  Env vars this patch reads (documentation only).
 *   capabilities string[]  Declared runtime powers. Allowed values:
 *                            network | fs | prompt | tools | env | exec | telemetry
 *                          Empty/missing = purely cosmetic. See THREAT_MODEL.md.
 *   tags         string[]  Searchable tags for filtering.
 *   preload      boolean   When true, this patch can run as a --require preload (no bundle mod).
 *   preloadCode  string    Raw JS string injected by the preload builder (required if preload=true).
 *   required     boolean   When true, no-change / verify-fail / apply-error makes the build fail
 *                          (same effect as global --strict, but scoped to this patch). Set on
 *                          patches whose absence would produce a broken or misleading bundle.
 *   fallbackDiff object    Stored unified diff applied when apply() returns no
 *                          change (anchor likely drifted). Shape:
 *                            { patch: string, capturedAgainst: string, fuzz?: number }
 *                          - patch:           unified-diff text (patch-package style)
 *                          - capturedAgainst: CC version captured against (informational)
 *                          - fuzz:            applyPatch fuzzFactor (default 3)
 *                          Skipped when patchOptions.disableFallback is true (--no-fallback).
 *   onBeforeApply function  Lifecycle hook (sync or async) called before
 *                            resolveAt/compileKind/apply. Receives a per-patch
 *                            ctx { name, phase, code, appliedCode, opts,
 *                            verify, attempt, logger }. May mutate ctx.opts or
 *                            ctx.code. Errors throw → patch fails. See
 *                            CONTRIBUTING.md "Patch lifecycle hooks".
 *   onAfterApply  function  Lifecycle hook called after apply() (and any
 *                            fallback-diff). May mutate ctx.appliedCode for
 *                            last-mile fixups. Errors throw → patch fails.
 *   onVerifyFail  function  Lifecycle hook called when verify finds issues.
 *                            Return a string to retry verify against that code
 *                            (max 1 retry); anything else gives up.
 *   coverageMarker string  Opt-in runtime coverage. When set, the runner auto-injects a
 *                          `__ccpCovHit('<marker>')` call into the patched code at apply time
 *                          (best-effort). Cross-referenced by `ccpatch coverage` to detect
 *                          patches that applied but never executed (DEAD). See CONTRIBUTING.md
 *                          "Coverage — apply-time + runtime instrumentation".
 *   revisit      object    Marker for forensic patches that target a specific upstream regression
 *                          and should be re-evaluated as upstream evolves. Shape:
 *                            { note: string, addedIn?: string, until?: string }
 *                          - note:    required, one-line reason this patch exists
 *                          - addedIn: CC version this patch was first needed for (e.g. "2.1.131")
 *                          - until:   CC version at/after which to re-check whether upstream fixed
 *                                     the issue. When the build runs against a CC version >= until,
 *                                     the runner emits a [revisit] warning.
 */

import { parseVariantStem, compareVersions } from './version-resolver.mjs';
import {
  CAPABILITIES_LIST,
  APPLY_MODES_LIST,
  CATEGORIES_LIST,
  PHASES_LIST,
  KINDS_LIST,
  fieldHint,
  missingField,
} from './manifest-schema.mjs';
// Cohesive field-validators extracted from validateManifest (task 4 refactor).
// AT_KINDS_LIST / FIELD_HINTS moved with them (the only remaining consumers).
import { validateVerify, validateAt } from './manifest-validators.mjs';

// Enum sets are derived from the ONE declarative schema in manifest-schema.mjs,
// which also drives the generated types/patch.d.ts (see scripts/gen-types.mjs).
const APPLY_MODES = new Set(APPLY_MODES_LIST);
const CATEGORIES  = new Set(CATEGORIES_LIST);
const PHASES      = new Set(PHASES_LIST);
const KIND_SET    = new Set(KINDS_LIST);

/**
 * Capability vocabulary — see THREAT_MODEL.md.
 * Sourced from the declarative schema (manifest-schema.mjs CAPABILITY_ENUM).
 * Each value documents a power the runtime patch can exercise inside the
 * patched bundle. Listed honestly by the patch author so users can audit
 * what an enabled patch is allowed to do.
 */
export const CAPABILITIES = CAPABILITIES_LIST;
const CAPABILITY_SET = new Set(CAPABILITIES);

const MEDIUM_RISK = new Set(['prompt', 'fs', 'env']);
const HIGH_RISK   = new Set(['network', 'tools', 'exec', 'telemetry']);

/**
 * Classify a capability array as low / medium / high risk.
 *   - 0 caps                                 → low
 *   - any of {network,tools,exec,telemetry}  → high
 *   - otherwise (any of {prompt,fs,env})     → medium
 */
export function classifyRisk(caps) {
  const list = Array.isArray(caps) ? caps : [];
  if (list.length === 0) return 'low';
  for (const c of list) if (HIGH_RISK.has(c)) return 'high';
  for (const c of list) if (MEDIUM_RISK.has(c)) return 'medium';
  return 'low';
}

/**
 * Deprecation retirement lifecycle (DX#3). Given a normalized patch and the CC
 * version the build is targeting, decide whether the patch has outlived its
 * `deprecated.removeAfter` and should be deleted. Returns a one-line warning
 * string when the build version is >= removeAfter, else null.
 *
 * Keeping the policy here (next to validateManifest) means both the runner and
 * any reporter/CLI can share ONE definition of "this no-op has overstayed its
 * welcome" rather than each re-deriving the comparison.
 *
 *   @param {object} normalized - validateManifest().normalized (or any object
 *                                with { name, deprecated }).
 *   @param {string} [version]  - target CC version, e.g. "2.1.156". When absent
 *                                or unparseable, no warning is produced (we can't
 *                                know whether removeAfter has been reached).
 *   @returns {string|null}
 */
export function deprecationWarning(normalized, version) {
  const dep = normalized && normalized.deprecated;
  if (!dep || !dep.removeAfter || !version) return null;
  const cmp = compareVersions(version, dep.removeAfter);
  if (cmp === null || cmp < 0) return null;
  const name = normalized.name ?? 'patch';
  const since = dep.since ? ` since ${dep.since}` : '';
  return `  [deprecated] ${name} deprecated${since}, scheduled for removal after ${dep.removeAfter}; remove it — ${dep.reason}`;
}

/**
 * @param {object} mod - the default export of a patch module
 * @param {string} filename - basename of the patch file, e.g. "hook_noise_mute.mjs"
 * @param {object} [ctx] - resolution context. ctx.variant is 'default' or a
 *                         variant stem like "2.1.148" / ">=2.1.150". When
 *                         variant !== 'default', testedAgainst must be present
 *                         and consistent with the stem.
 *                         ctx.version (optional) is the target CC version; when
 *                         supplied alongside ctx.logger, a deprecated patch past
 *                         its removeAfter emits a [deprecated] retirement warning
 *                         (see deprecationWarning). Under ctx.strict it is also
 *                         pushed onto errors so a release build fails on dead no-ops.
 * @returns {{ ok: boolean, errors: string[], normalized: object }}
 */
export function validateManifest(mod, filename, ctx = {}) {
  const errors = [];
  const stem = filename.replace(/\.mjs$/, '');
  const variant = ctx.variant ?? 'default';

  // Required: description
  // U3: rejection teaches the field name, expected type and a correct example.
  if (!mod.description || typeof mod.description !== 'string') {
    errors.push(missingField('description'));
  }

  // verify is required. At least one of present/absent/count must be specified.
  // Extracted to manifest-validators.validateVerify() (task 4) — same checks,
  // same error strings, same order.
  errors.push(...validateVerify(mod, stem));
  if (mod.verifyExempt !== undefined) {
    errors.push(`patch ${stem}: 'verifyExempt' is no longer supported — provide a real verify block (see CONTRIBUTING.md)`);
  }

  // overlay (Magisk-style sibling-file shim, see runner/overlay-builder.mjs).
  // Optional. When present, both fields are required and non-empty strings.
  if (mod.overlay !== undefined) {
    if (!mod.overlay || typeof mod.overlay !== 'object' || Array.isArray(mod.overlay)) {
      errors.push(fieldHint('overlay', 'must be an object: { register: string, code: string }'));
    } else {
      if (typeof mod.overlay.register !== 'string' || mod.overlay.register.length === 0) {
        errors.push(fieldHint('overlay', '.register is required and must be a non-empty string'));
      }
      if (typeof mod.overlay.code !== 'string' || mod.overlay.code.length === 0) {
        errors.push(fieldHint('overlay', '.code is required and must be a non-empty string'));
      }
    }
  }

  // preload consistency
  if (mod.preload === true && !mod.preloadCode) {
    // When a logger is present (runtime load), downgrade to a warning — the
    // preload-builder will look for a companion <name>.preload.mjs file.
    // When there is no logger (validation-only / CI strict mode), keep the
    // hard error so patches missing both preloadCode and companion file are
    // caught early.
    if (ctx.logger) {
      ctx.logger.warn(`preload:true without preloadCode — a companion ${stem}.preload.mjs will be expected`);
    } else {
      errors.push('preload:true requires a preloadCode string — e.g. preloadCode: \'globalThis.__x = 1;\' (or provide a companion ' + stem + '.preload.mjs file)');
    }
  }
  if (mod.preloadCode && mod.preload !== true) {
    errors.push('preloadCode is set but preload:true is missing — add preload: true to enable the --require variant');
  }

  // Optional category
  if (mod.category !== undefined) {
    if (!CATEGORIES.has(mod.category)) {
      errors.push(fieldHint('category', `must be one of: ${[...CATEGORIES].join(', ')} (got "${mod.category}")`));
    }
  }

  // Optional enabled hint (ccpatch.yml is authoritative; this is documentation)
  if (mod.enabled !== undefined && typeof mod.enabled !== 'boolean') {
    errors.push(fieldHint('enabled'));
  }

  // Optional required flag — promotes failures to fatal even outside --strict.
  if (mod.required !== undefined && typeof mod.required !== 'boolean') {
    errors.push(fieldHint('required'));
  }

  // Optional name — if present, must match stem
  if (mod.name !== undefined) {
    if (typeof mod.name !== 'string') {
      errors.push(fieldHint('name', 'must be a string'));
    } else if (mod.name !== stem) {
      errors.push(`name mismatch: manifest says "${mod.name}", filename stem is "${stem}" — set name: '${stem}' or rename the file`);
    }
  }

  // Optional applyMode — must be enum if present
  const applyMode = mod.applyMode ?? 'build';
  if (!APPLY_MODES.has(applyMode)) {
    errors.push(fieldHint('applyMode', `must be one of: ${[...APPLY_MODES].join(', ')} (got "${applyMode}")`));
  }

  // kind — declarative patch shape (default 'free' = the apply() escape hatch).
  const kind = mod.kind ?? 'free';
  if (!KIND_SET.has(kind)) {
    errors.push(fieldHint('kind', `must be one of: ${[...KIND_SET].join(', ')} (got "${kind}")`));
  }

  // bootInject — declarative boot hook, spliced ONCE by the runner's boot
  // registry (runner/boot-registry.mjs) instead of a hand-rolled apply()
  // splice at the shebang / CJS-IIFE anchor. Shape:
  //   { code: string | (options) => string, order?: int, sentinel?: string }
  let bootInjectValid = false;
  if (mod.bootInject !== undefined) {
    if (!mod.bootInject || typeof mod.bootInject !== 'object' || Array.isArray(mod.bootInject)) {
      errors.push(fieldHint('bootInject', 'must be an object: { code: string | (options) => string, order?: int, sentinel?: string }'));
    } else {
      const bi = mod.bootInject;
      let ok = true;
      if (typeof bi.code !== 'string' && typeof bi.code !== 'function') {
        errors.push(fieldHint('bootInject', '.code is required and must be a string or a (options) => string function'));
        ok = false;
      } else if (typeof bi.code === 'string' && bi.code.length === 0) {
        errors.push(fieldHint('bootInject', '.code must be a non-empty string'));
        ok = false;
      }
      if (bi.order !== undefined
          && (typeof bi.order !== 'number' || !Number.isFinite(bi.order) || !Number.isInteger(bi.order))) {
        errors.push(fieldHint('bootInject', '.order must be a finite integer (lower runs first; use gaps of 10)'));
        ok = false;
      }
      if (bi.sentinel !== undefined && (typeof bi.sentinel !== 'string' || bi.sentinel.length === 0)) {
        errors.push(fieldHint('bootInject', '.sentinel must be a non-empty string if defined'));
        ok = false;
      }
      bootInjectValid = ok;
    }
    if (kind !== 'free') {
      errors.push(`bootInject is only valid on kind="free" patches (got kind="${kind}")`);
    }
  }

  if (kind === 'free') {
    // apply() required for free kind — unless the patch is boot-only (a valid
    // bootInject declaration is its entire transformation; the runner's boot
    // registry performs the splice).
    if (typeof mod.apply !== 'function' && !bootInjectValid) {
      errors.push(`apply must be a function when kind is "free" / applyMode is "${applyMode}" — e.g. apply(code) { return code; } (boot-only patches may declare bootInject instead)`);
    }
  } else {
    // Non-free kinds synthesize apply() from declarative fields. A user-supplied
    // apply() is rejected to avoid two sources of truth.
    if (mod.apply !== undefined) {
      errors.push(`kind="${kind}" patches must not export apply() — the runner synthesizes apply from kind/target/code; drop apply() and keep target/code/transform`);
    }
    if (!mod.target || typeof mod.target !== 'object' || !mod.target.function) {
      errors.push(`kind="${kind}" requires ${fieldHint('target.function')}`);
    }
    if (kind === 'prefix' || kind === 'postfix') {
      if (typeof mod.code !== 'string') {
        errors.push(`kind="${kind}" requires ${fieldHint('code', 'a code: string (verbatim JS to inject)')}`);
      }
    }
    if (kind === 'transpiler') {
      if (typeof mod.transform !== 'function') {
        errors.push(`kind="transpiler" requires ${fieldHint('transform', 'a transform: (functionBody, opts) => string')}`);
      }
    }
  }

  // anchor — if present, must have literal string
  if (mod.anchor !== undefined) {
    if (!mod.anchor || typeof mod.anchor.literal !== 'string') {
      errors.push(fieldHint('anchor', 'must be { literal: string, byteOffset?: number }'));
    }
  }

  // @At selector — declarative anchor. See runner/at-selector.mjs.
  // Extracted to manifest-validators.validateAt() (task 4) — same checks,
  // same error strings, same order; returns the accepted selector (or null).
  const atResult = validateAt(mod);
  errors.push(...atResult.errors);
  const at = atResult.at;

  // dependsOn — default []
  const dependsOn = mod.dependsOn ?? [];
  if (!Array.isArray(dependsOn)) {
    errors.push(fieldHint('dependsOn', 'must be an array'));
  }

  // phase — default 'main'
  const phase = mod.phase ?? 'main';
  if (!PHASES.has(phase)) {
    errors.push(fieldHint('phase', `must be one of: ${[...PHASES].join(', ')} (got "${phase}")`));
  }

  // Optional priority — lower runs first within a phase, breaks topo ties.
  // dependsOn is still authoritative; priority only orders peers that have no
  // dependency relationship. Default 1000.
  let priority = 1000;
  if (mod.priority !== undefined) {
    if (typeof mod.priority !== 'number' || !Number.isFinite(mod.priority) || !Number.isInteger(mod.priority)) {
      errors.push(fieldHint('priority', 'must be a finite integer (lower runs first within a phase; default 1000)'));
    } else {
      priority = mod.priority;
    }
  }

  // Optional allowOverlapWith — acknowledged overlapping peers.
  // See "Priority and overlap detection" in CONTRIBUTING.md.
  let allowOverlapWith = [];
  if (mod.allowOverlapWith !== undefined) {
    if (!Array.isArray(mod.allowOverlapWith)
        || mod.allowOverlapWith.some(x => typeof x !== 'string' || !x.trim())) {
      errors.push(fieldHint('allowOverlapWith', 'must be an array of non-empty strings (patch names)'));
    } else {
      allowOverlapWith = [...new Set(mod.allowOverlapWith.map(s => s.trim()))];
    }
  }

  // Optional capabilities — patch's declared powers (see THREAT_MODEL.md).
  let capabilities = [];
  if (mod.capabilities !== undefined) {
    if (!Array.isArray(mod.capabilities)) {
      errors.push(fieldHint('capabilities', 'must be an array of strings'));
    } else {
      const bad = mod.capabilities.filter(c => !CAPABILITY_SET.has(c));
      if (bad.length > 0) {
        errors.push(
          `capabilities contains unknown value(s): ${bad.join(', ')}. ` +
          `Allowed: ${CAPABILITIES.join(', ')} — e.g. capabilities: ['prompt', 'fs']`
        );
      }
      // Dedupe while preserving declared order.
      capabilities = [...new Set(mod.capabilities.filter(c => CAPABILITY_SET.has(c)))];
    }
  }

  // Optional fallbackDiff — patch-package-style unified diff used when apply()
  // produces no change (anchor likely drifted). See CONTRIBUTING.md.
  let fallbackDiff = null;
  if (mod.fallbackDiff !== undefined) {
    if (!mod.fallbackDiff || typeof mod.fallbackDiff !== 'object' || Array.isArray(mod.fallbackDiff)) {
      errors.push(fieldHint('fallbackDiff', 'must be an object: { patch: string, capturedAgainst: string, fuzz?: number }'));
    } else {
      const fd = mod.fallbackDiff;
      if (typeof fd.patch !== 'string' || !fd.patch.trim()) {
        errors.push(fieldHint('fallbackDiff', '.patch is required and must be a non-empty unified-diff string'));
      }
      if (typeof fd.capturedAgainst !== 'string' || !fd.capturedAgainst.trim()) {
        errors.push(fieldHint('fallbackDiff', '.capturedAgainst is required and must be a non-empty string (CC version it was captured against)'));
      }
      if (fd.fuzz !== undefined) {
        if (typeof fd.fuzz !== 'number' || !Number.isFinite(fd.fuzz) || fd.fuzz < 0 || !Number.isInteger(fd.fuzz)) {
          errors.push(fieldHint('fallbackDiff', '.fuzz must be a non-negative integer'));
        }
      }
      if (typeof fd.patch === 'string' && typeof fd.capturedAgainst === 'string') {
        fallbackDiff = {
          patch: fd.patch,
          capturedAgainst: fd.capturedAgainst,
          fuzz: typeof fd.fuzz === 'number' ? fd.fuzz : 3,
        };
      }
    }
  }

  // Optional lifecycle hooks — each must be a function (sync or async) if set.
  for (const hookName of ['onBeforeApply', 'onAfterApply', 'onVerifyFail']) {
    if (mod[hookName] !== undefined && typeof mod[hookName] !== 'function') {
      errors.push(`${hookName} must be a function (sync or async) if defined`);
    }
  }

  // Optional forbiddenAfterPatch — substrings that must NOT appear in the
  // patched bundle. Checked by dry-run / shadow mode (see runner/shadow.mjs).
  // Defense against accidentally injecting common debug strings (console.log,
  // debugger, etc.). Validated as a non-empty array of non-empty strings.
  let forbiddenAfterPatch = [];
  if (mod.forbiddenAfterPatch !== undefined) {
    if (!Array.isArray(mod.forbiddenAfterPatch)
        || mod.forbiddenAfterPatch.some(s => typeof s !== 'string' || s.length === 0)) {
      errors.push(fieldHint('forbiddenAfterPatch', 'must be an array of non-empty strings'));
    } else {
      forbiddenAfterPatch = [...mod.forbiddenAfterPatch];
    }
  }

  // Optional coverageMarker — opts the patch into runtime coverage tracking.
  // When set, the runner injects a `__ccpRequire('cov').hit('<marker>')` call
  // into the patched code (best-effort; see runner.mjs). The `ccpatch coverage`
  // command later cross-references hits with apply-time results.
  let coverageMarker = null;
  if (mod.coverageMarker !== undefined) {
    if (typeof mod.coverageMarker !== 'string' || mod.coverageMarker.trim().length === 0) {
      errors.push(fieldHint('coverageMarker', 'must be a non-empty string'));
    } else {
      coverageMarker = mod.coverageMarker.trim();
    }
  }

  // Optional deprecated — marks the patch as no-longer-needed (e.g. upstream
  // fixed the issue or removed the feature flag). Reporters render this as a
  // dedicated status instead of "ok".
  let deprecated = null;
  if (mod.deprecated !== undefined) {
    if (!mod.deprecated || typeof mod.deprecated !== 'object' || Array.isArray(mod.deprecated)) {
      errors.push(fieldHint('deprecated', 'must be an object: { reason: string, since?: string }'));
    } else {
      if (typeof mod.deprecated.reason !== 'string' || !mod.deprecated.reason.trim()) {
        errors.push(fieldHint('deprecated', '.reason is required and must be a non-empty string'));
      }
      if (mod.deprecated.since !== undefined && typeof mod.deprecated.since !== 'string') {
        errors.push(fieldHint('deprecated', '.since must be a string if defined'));
      }
      // removeAfter arms the retirement lifecycle (see deprecationWarning). When
      // present it must be a parseable version so the comparison can fire.
      if (mod.deprecated.removeAfter !== undefined) {
        if (typeof mod.deprecated.removeAfter !== 'string' || !mod.deprecated.removeAfter.trim()) {
          errors.push(fieldHint('deprecated', '.removeAfter must be a non-empty version string if defined'));
        } else if (parseVariantStem(mod.deprecated.removeAfter.trim()) == null) {
          errors.push(fieldHint('deprecated', `.removeAfter "${mod.deprecated.removeAfter}" is not a valid version`));
        }
      }
      if (typeof mod.deprecated.reason === 'string' && mod.deprecated.reason.trim()) {
        deprecated = {
          reason: mod.deprecated.reason.trim(),
          since: typeof mod.deprecated.since === 'string' ? mod.deprecated.since : undefined,
        };
        // Only attach removeAfter when actually present so the normalized shape
        // stays { reason, since } for non-retiring deprecations (preserves
        // existing deepEqual expectations).
        if (typeof mod.deprecated.removeAfter === 'string') {
          deprecated.removeAfter = mod.deprecated.removeAfter.trim();
        }
      }
    }
  }

  // Optional revisit — forensic-patch metadata
  if (mod.revisit !== undefined) {
    if (!mod.revisit || typeof mod.revisit !== 'object' || Array.isArray(mod.revisit)) {
      errors.push(fieldHint('revisit', 'must be an object: { note: string, addedIn?: string, until?: string }'));
    } else {
      if (typeof mod.revisit.note !== 'string' || !mod.revisit.note.trim()) {
        errors.push(fieldHint('revisit', '.note is required and must be a non-empty string'));
      }
      for (const k of ['addedIn', 'until']) {
        if (mod.revisit[k] !== undefined && typeof mod.revisit[k] !== 'string') {
          errors.push(`revisit.${k} must be a string (semver-like, e.g. "2.1.131")`);
        }
      }
    }
  }

  // testedAgainst — required on per-version variant files; optional on defaults.
  // Shape: array of strings, each either "X.Y.Z" or a range expression
  // (">=X", "<X", ">=X,<Y"). For non-default variants, every entry must equal
  // the filename variant stem (the file makes a specific compatibility claim
  // and the entry must match it; mismatch is a fatal manifest error).
  let testedAgainst = null;
  if (mod.testedAgainst !== undefined) {
    if (!Array.isArray(mod.testedAgainst) || mod.testedAgainst.length === 0
        || mod.testedAgainst.some(x => typeof x !== 'string' || !x.trim())) {
      errors.push(fieldHint('testedAgainst', 'must be a non-empty array of strings (e.g. ["2.1.148"] or [">=2.1.150"])'));
    } else {
      testedAgainst = mod.testedAgainst.map(s => s.trim());
      for (const entry of testedAgainst) {
        if (parseVariantStem(entry) == null) {
          errors.push(`testedAgainst entry "${entry}" is not a valid version or range`);
        }
      }
      if (variant !== 'default') {
        if (!testedAgainst.includes(variant)) {
          errors.push(
            `testedAgainst ${JSON.stringify(testedAgainst)} does not match filename variant "${variant}" — ` +
            `per-version files must declare their own version in testedAgainst`
          );
        }
      }
    }
  } else if (variant !== 'default') {
    errors.push(
      `per-version variant "${variant}" requires a testedAgainst field (e.g. testedAgainst: ['${variant}'])`
    );
  }

  const normalized = {
    name: stem,
    version: mod.version ?? '0.0.0',
    description: mod.description ?? '',
    category: mod.category ?? null,
    enabled: mod.enabled ?? true,
    env: Array.isArray(mod.env) ? mod.env : [],
    tags: Array.isArray(mod.tags) ? mod.tags : [],
    dependsOn,
    phase,
    applyMode,
    anchor: mod.anchor ?? null,
    apply: mod.apply ?? null,
    bootInject: bootInjectValid ? mod.bootInject : null,
    preload: mod.preload === true,
    preloadCode: mod.preloadCode ?? null,
    verify: mod.verify ?? null,
    required: mod.required === true,
    deprecated,
    revisit: mod.revisit ?? null,
    forbiddenAfterPatch,
    fallbackDiff,
    testedAgainst,
    resolvedVariant: variant,
    capabilities,
    risk: classifyRisk(capabilities),
    priority,
    allowOverlapWith,
    at,
    kind,
    target: mod.target ?? null,
    code: typeof mod.code === 'string' ? mod.code : null,
    overlay: (mod.overlay && typeof mod.overlay === 'object' && !Array.isArray(mod.overlay)
      && typeof mod.overlay.register === 'string' && mod.overlay.register.length > 0
      && typeof mod.overlay.code === 'string' && mod.overlay.code.length > 0)
      ? { register: mod.overlay.register, code: mod.overlay.code }
      : null,
    transform: typeof mod.transform === 'function' ? mod.transform : null,
    coverageMarker,
  };

  // Retirement nudge (DX#3): a deprecated patch carried past its removeAfter
  // version is dead weight. Warn (so no-ops can't silently accumulate), and
  // under strict promote it to a hard error so release builds force the cleanup.
  // Only fires when the caller supplies the target version via ctx.version.
  if (errors.length === 0 && ctx.version) {
    const retire = deprecationWarning(normalized, ctx.version);
    if (retire) {
      if (ctx.strict) {
        errors.push(retire.trim());
      } else if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(retire);
      }
    }
  }

  return { ok: errors.length === 0, errors, normalized };
}

/**
 * Resolve a profile name to its patch list.
 *   profileName: e.g. "minimal" | "standard" | "power"
 *   profiles:    map returned by readProfiles()  (may be null)
 *   knownNames:  set of all loaded patch names (used to filter typos out silently —
 *                an unknown patch in a profile is a config issue, not a runtime one;
 *                we warn via the returned `unknown` list).
 * Throws if profileName is not in profiles.
 */
export function resolveProfile(profileName, profiles, knownNames) {
  if (!profiles || !profiles[profileName]) {
    const valid = profiles ? Object.keys(profiles).sort().join(', ') : '(none defined in ccpatch.yml)';
    throw new Error(`Unknown profile "${profileName}". Valid: ${valid}`);
  }
  const requested = profiles[profileName];
  const known = new Set(knownNames);
  const enabled = [];
  const unknown = [];
  for (const name of requested) {
    if (known.has(name)) enabled.push(name);
    else unknown.push(name);
  }
  return { enabled, unknown };
}

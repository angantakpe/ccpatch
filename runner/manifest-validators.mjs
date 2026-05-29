/**
 * Cohesive field-validators extracted from manifest.mjs validateManifest()
 * (task 4 — pure refactor, no behavior change). Each validator is pure: it
 * reads the raw module + filename stem and returns the exact same error strings
 * the inline code produced, in the same order. validateManifest() splices these
 * back into its `errors` array verbatim, so observable behavior is unchanged.
 */

import { AT_KINDS_LIST, FIELD_HINTS, fieldHint, missingField } from './manifest-schema.mjs';

const AT_KIND_SET = new Set(AT_KINDS_LIST);

/**
 * Validate the (required) `verify` block. Returns an array of error strings
 * (empty when valid). Byte-identical to the former inline block.
 *
 * @param {object} mod
 * @param {string} stem  filename stem (for the "patch <stem>:" prefixed messages)
 * @returns {string[]}
 */
export function validateVerify(mod, stem) {
  const errors = [];
  if (!mod.verify || typeof mod.verify !== 'object') {
    errors.push(`patch ${stem}: ${missingField('verify')} — see CONTRIBUTING.md`);
    return errors;
  }
  const v = mod.verify;
  const hasPresent = v.present !== undefined && v.present !== null
    && (Array.isArray(v.present) ? v.present.length > 0 : true);
  const hasAbsent = v.absent !== undefined && v.absent !== null
    && (Array.isArray(v.absent) ? v.absent.length > 0 : true);
  const hasCount = v.count !== undefined && v.count !== null;
  if (!hasPresent && !hasAbsent && !hasCount) {
    errors.push(`patch ${stem}: ${fieldHint('verify', 'must specify at least one of present/absent/count')} — see CONTRIBUTING.md`);
  }
  // Weak-verify guard: present-only verify cannot detect wrong-location apply
  // or double-apply. Require opt-in via verify.weak:true.
  if (hasPresent && !hasAbsent && !hasCount && v.weak !== true) {
    errors.push(`weak verify: declare verify.absent or verify.count, or opt in with verify.weak: true — e.g. ${FIELD_HINTS['verify.weak'].example}`);
  }
  if (v.weak !== undefined && typeof v.weak !== 'boolean') {
    errors.push(fieldHint('verify.weak'));
  }
  if (hasCount) {
    const c = v.count;
    if (typeof c === 'number') {
      if (!Number.isFinite(c) || c < 0) errors.push(fieldHint('verify.count', '(number) must be a non-negative integer'));
    } else if (typeof c === 'object') {
      if (c.present !== undefined && (!Number.isFinite(c.present) || c.present < 0)) {
        errors.push(fieldHint('verify.count', '.present must be a non-negative integer'));
      }
      if (c.absent !== undefined && (!Number.isFinite(c.absent) || c.absent < 0)) {
        errors.push(fieldHint('verify.count', '.absent must be a non-negative integer'));
      }
    } else {
      errors.push(fieldHint('verify.count', 'must be a number or { present?, absent? }'));
    }
  }
  return errors;
}

/**
 * Validate the optional `@At` selector. Returns { errors, at } where `at` is the
 * accepted selector object (mod.at) when the kind/target shape validated, else
 * null. Byte-identical to the former inline block, including the final
 * "apply() is missing" contract check.
 *
 * @param {object} mod
 * @returns {{ errors: string[], at: object|null }}
 */
export function validateAt(mod) {
  const errors = [];
  let at = null;
  if (mod.at === undefined) return { errors, at };

  if (!mod.at || typeof mod.at !== 'object' || Array.isArray(mod.at)) {
    errors.push(fieldHint('at', 'must be an object: { kind, target }'));
  } else if (!AT_KIND_SET.has(mod.at.kind)) {
    errors.push(fieldHint('at.kind', `must be one of: ${[...AT_KIND_SET].join(', ')} (got "${mod.at.kind}")`));
  } else if (!mod.at.target || typeof mod.at.target !== 'object') {
    errors.push('at.target is required and must be an object — e.g. target: { function: \'foo\' }');
  } else {
    const k = mod.at.kind;
    const t = mod.at.target;
    const isFnSpec = (val) => typeof val === 'string'
      || (val && typeof val === 'object' && typeof val.literal === 'string');
    if (k === 'HEAD' || k === 'RETURN') {
      if (!isFnSpec(t.function)) {
        errors.push(`at.target.function is required for ${k}: 'NAME' or { literal: 'STR' }`);
      }
    } else if (k === 'INVOKE') {
      if (!isFnSpec(t.call)) {
        errors.push(`at.target.call is required for INVOKE: 'NAME' or { literal: 'STR' }`);
      }
      if (t.occurrence !== undefined && (!Number.isInteger(t.occurrence) || t.occurrence < 1)) {
        errors.push(`at.target.occurrence must be a positive integer`);
      }
      if (t.in !== undefined && !isFnSpec(t.in)) {
        errors.push(`at.target.in (when set) must be 'NAME' or { literal: 'STR' }`);
      }
    } else if (k === 'BEFORE' || k === 'AFTER') {
      if (typeof t.literal !== 'string' || t.literal.length === 0) {
        errors.push(`at.target.literal is required for ${k} and must be a non-empty string`);
      }
      if (t.occurrence !== undefined && (!Number.isInteger(t.occurrence) || t.occurrence < 1)) {
        errors.push(`at.target.occurrence must be a positive integer`);
      }
    }
    at = mod.at;
  }
  // Contract: an `at` selector requires apply() to consume the sites.
  if (at && typeof mod.apply !== 'function') {
    errors.push('at: selector is set but apply() is missing — apply must consume atSites');
  }
  return { errors, at };
}

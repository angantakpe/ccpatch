import { findFunctionByLiteral } from '../runner/ast-anchor.mjs';
import { resolveAnchorLiteral } from '../runner/anchors.mjs';

export default {
  category: 'feature',

  description: 'Unlock the plan mode interview phase (tengu_plan_mode_interview_phase)',
  capabilities: ["env"],
  deprecated: { reason: 'upstream removed feature flag', since: '2.1.146' },
  // absent check passes both when the flag is replaced with !0 AND when the flag was
  // removed upstream (no-op case) — the string won't be present in either outcome.
  verify: { absent: '"tengu_plan_mode_interview_phase",!1' },
  apply: (code, opts) => {
    // The feature flag was removed upstream in v2.1.146 — detect the removal first
    // so we don't print a misleading warning.
    if (!code.includes('tengu_plan_mode_interview_phase')) {
      console.log('  [plan_mode_interview] feature flag removed upstream — patch is now a no-op');
      return code;
    }

    const literal = resolveAnchorLiteral('isPlanModeInterviewEnabled');
    const fn = findFunctionByLiteral(code, literal);
    if (!fn) {
      console.warn('  [!] plan_mode_interview: gate function anchor not matched — update runner/anchors.mjs for this version');
      return code;
    }
    code = code.slice(0, fn.start) + 'function ' + fn.name + '(){return !0}' + code.slice(fn.end);
    console.log('  [plan_mode_interview] interview phase enabled (fn: ' + fn.name + ')');
    return code;
  },
};

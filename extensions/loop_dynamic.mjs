import { findFunctionByLiteral } from '../runner/ast-anchor.mjs';
import { resolveAnchorLiteral } from '../runner/anchors.mjs';

export default {
  category: 'feature',

  description: 'Unlock self-pacing loops (tengu_kairos_loop_dynamic) and richer loop prompts (tengu_kairos_loop_prompt)',
  capabilities: [],
  verify: { absent: '"tengu_kairos_loop_dynamic",!1' },
  apply: (code) => {
    let patched = 0;

    const fnDyn = findFunctionByLiteral(code, resolveAnchorLiteral('isLoopDynamicEnabled'));
    if (fnDyn) {
      code = code.slice(0, fnDyn.start) + 'function ' + fnDyn.name + '(){return !0}' + code.slice(fnDyn.end);
      patched++;
    } else {
      console.warn('  [!] loop_dynamic: anchor 1 (tengu_kairos_loop_dynamic) not matched — update runner/anchors.mjs for this version');
    }

    const fnPrompt = findFunctionByLiteral(code, resolveAnchorLiteral('isLoopPromptEnabled'));
    if (fnPrompt) {
      code = code.slice(0, fnPrompt.start) + 'function ' + fnPrompt.name + '(){return !0}' + code.slice(fnPrompt.end);
      patched++;
    } else {
      console.warn('  [!] loop_dynamic: anchor 2 (tengu_kairos_loop_prompt) not matched — update runner/anchors.mjs for this version');
    }

    if (patched > 0) {
      console.log('  [loop_dynamic] ' + patched + '/2 flag(s) enabled');
    }
    return code;
  },
};

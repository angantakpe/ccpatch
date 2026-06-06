import { forceFeatureFlag } from '../runner/patch-helpers.mjs';
import { resolveAnchorLiteral } from '../runner/anchors.mjs';
import { ccpLog } from '../runner/cli/style.mjs';

export default {
  category: 'feature',

  description: 'Unlock self-pacing loops (tengu_kairos_loop_dynamic) and richer loop prompts (tengu_kairos_loop_prompt)',
  capabilities: [],
  verify: { absent: '"tengu_kairos_loop_dynamic",!1' },
  // Two independent feature-flag functions, each forced to `return !0` via the
  // shared forceFeatureFlag helper so the override logic is uniform. allowMissing
  // keeps a single missing anchor from aborting the whole build while still
  // warning; verify.absent catches any genuine regression.
  apply: (code) => {
    let patched = 0;

    const dyn = forceFeatureFlag(code, resolveAnchorLiteral('isLoopDynamicEnabled'), { allowMissing: true });
    if (dyn.fnName) {
      code = dyn.code;
      patched++;
    } else {
      console.warn('  [!] loop_dynamic: anchor 1 (tengu_kairos_loop_dynamic) not matched — update runner/anchors.mjs for this version');
    }

    const prompt = forceFeatureFlag(code, resolveAnchorLiteral('isLoopPromptEnabled'), { allowMissing: true });
    if (prompt.fnName) {
      code = prompt.code;
      patched++;
    } else {
      console.warn('  [!] loop_dynamic: anchor 2 (tengu_kairos_loop_prompt) not matched — update runner/anchors.mjs for this version');
    }

    if (patched > 0) {
      ccpLog('  [loop_dynamic] ' + patched + '/2 flag(s) enabled');
    }
    return code;
  },
};

import { ccpLog } from '../runner/cli/style.mjs';

// Upstream breakage in v2.1.131: new display item types (grouped_tool_use,
// collapsed_read_search) produced by cq4()/dQ7() hit unguarded paths in
// zr_() and RY$(). These three substitutions harden those paths.
// v2.1.132: fs_() default case also returns bare H instead of [H], causing
// _.push(...H) to throw a spread-iterator TypeError for unknown message types.
// v2.1.133: zr_/fs_ renamed to xt_; en7 renamed to Ii7; RY$ renamed to Af$.
// The display-item normalizer function name has drifted across versions:
// Af$ (<=v2.1.137), h3$ (<=v2.1.144), bP$ (v2.1.145), cW$ (v2.1.146+).
// v2.1.181: the function's *parameter* name rotated from H to e (the body
// shape is unchanged). Anchoring on the literal param `H` is exactly the
// minified-identifier mistake rule #1 forbids, so both the function name AND
// the parameter are now regex-captured (the param via a \2 back-reference)
// and a stable sentinel comment `/*__ccpMsgNorm_v1*/` is injected so verify is
// param-independent.
const SENTINEL = '/*__ccpMsgNorm_v1*/';

// group 1 = normalizer fn name, group 2 = its (minified) parameter.
const guardRe =
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{if\(\2\.type==="progress"\|\|\2\.type==="attachment"\|\|\2\.type==="system"\)return!0;if\(typeof \2\.message\.content/;

// Second guard: null/undefined content before the bare `.length` read. The
// parameter is captured (group 1) so this never hard-codes a minified name.
const contentRe =
  /if\(typeof ([A-Za-z_$][\w$]*)\.message\.content==="string"\)return \1\.message\.content\.trim\(\)\.length>0;if\(\1\.message\.content\.length===0\)/;

export default {
  category: 'fix',

  description:
    "Guard zr_() default case and RY$() against v2.1.131 display item types.",
  capabilities: [],
  verify: { present: SENTINEL, count: { present: 1 } },
  // Self-check after apply: the sentinel + null-element guard must land *inside*
  // the display-item normalizer (right after its opening brace), not somewhere
  // else in the bundle. If the sentinel exists but its left-neighbour is not the
  // normalizer's opening `function NAME(param){`, something matched the wrong
  // site. Parameter-agnostic — matches any minified param name.
  onAfterApply(ctx) {
    const idx = ctx.appliedCode.indexOf(SENTINEL);
    if (idx < 0) return; // verify will catch this
    // Look back ~120 chars for the normalizer signature; tolerate variance.
    const window = ctx.appliedCode.slice(Math.max(0, idx - 120), idx);
    if (!/function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\{$/.test(window)) {
      ctx.logger.warn(
        `  [hook] message_normalizer.onAfterApply: sentinel "${SENTINEL}" did not land at the normalizer head (left-neighbour: ${JSON.stringify(window.slice(-60))})`,
      );
    }
  },
  revisit: {
    addedIn: '2.1.131',
    until: '2.2.0',
    note: 'Forensic guard for unhandled display-item types and renamed normalizer fn. Re-check whether upstream now handles grouped_tool_use/collapsed_read_search natively.',
  },
  apply(code) {
    // Idempotent: the sentinel only exists once the normalizer guard is in.
    if (code.includes(SENTINEL)) return code;

    let result = code;

    // First patch: sentinel + null-element + missing-.message guards on the
    // display-item normalizer. Function name AND parameter vary across
    // versions — regex-capture both (param via \2 back-reference).
    const m = result.match(guardRe);
    if (m) {
      const fn = m[1];
      const p = m[2];
      const anchor = `function ${fn}(${p}){if(${p}.type==="progress"||${p}.type==="attachment"||${p}.type==="system")return!0;if(typeof ${p}.message.content`;
      const replacement = `function ${fn}(${p}){${SENTINEL}if(!${p})return!1;if(${p}.type==="progress"||${p}.type==="attachment"||${p}.type==="system")return!0;if(!${p}.message)return!0;if(typeof ${p}.message.content`;
      result = result.replace(anchor, replacement);
      ccpLog(`  [+] message_normalizer: ${fn}(${p}) sentinel, null-element and missing-.message guards`);
    } else {
      console.warn(`  [!] message_normalizer: display-item normalizer anchor not found — skipping`);
    }

    // Second patch: null/undefined content guard before the bare `.length` read.
    const cm = result.match(contentRe);
    if (cm) {
      const p = cm[1];
      const anchor = `if(typeof ${p}.message.content==="string")return ${p}.message.content.trim().length>0;if(${p}.message.content.length===0)`;
      const replacement = `if(typeof ${p}.message.content==="string")return ${p}.message.content.trim().length>0;if(!${p}.message.content)return!1;if(${p}.message.content.length===0)`;
      result = result.replace(anchor, replacement);
      ccpLog(`  [+] message_normalizer: null/undefined content guard before .length`);
    } else {
      console.warn(
        `  [!] message_normalizer: "null/undefined content guard before .length" anchor not found — skipping`,
      );
    }

    return result;
  },
};

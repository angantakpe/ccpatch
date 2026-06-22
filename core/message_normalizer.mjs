import { ccpLog } from '../runner/cli/style.mjs';

// Upstream breakage in v2.1.131: new display item types (grouped_tool_use,
// collapsed_read_search) produced by cq4()/dQ7() hit unguarded paths in
// zr_() and RY$(). These three substitutions harden those paths.
// v2.1.132: fs_() default case also returns bare H instead of [H], causing
// _.push(...H) to throw a spread-iterator TypeError for unknown message types.
// v2.1.133: zr_/fs_ renamed to xt_; en7 renamed to Ii7; RY$ renamed to Af$.
// The display-item normalizer function name has drifted across versions:
// Af$ (<=v2.1.137), h3$ (<=v2.1.144), bP$ (v2.1.145), cW$ (v2.1.146+).
// v2.1.185: parameter name changed from H to e (minifier churn — capture it).
// Capture the name with a regex; the body shape is stable.
const guardRe = /function ([A-Za-z_$][\w$]*)\((\w+)\)\{if\(\2\.type==="progress"\|\|\2\.type==="attachment"\|\|\2\.type==="system"\)return!0;if\(typeof \2\.message\.content/;

export default {
  category: 'fix',

  description:
    "Guard zr_() default case and RY$() against v2.1.131 display item types.",
  capabilities: [],
  // verify.present uses the param name as of v2.1.185 (e); update if minifier
  // renames it again and the count check fails.
  verify: { present: 'if(!e.message)return!0;', count: { present: 1 } },
  // Self-check after apply: the null-element guard must land *inside* the
  // display-item normalizer (right after its opening brace), not somewhere
  // else in the bundle.
  onAfterApply(ctx) {
    // The sentinel starts with a param-agnostic prefix; find it by pattern.
    const sentinelRe = /if\(!\w+\)return!1;/;
    const m = sentinelRe.exec(ctx.appliedCode);
    if (!m) return; // verify will catch this
    const sentinel = m[0];
    const idx = m.index;
    // Look back ~120 chars for the normalizer signature; tolerate variance.
    const window = ctx.appliedCode.slice(Math.max(0, idx - 120), idx);
    if (!/function [A-Za-z_$][\w$]*\(\w+\)\{$/.test(window)) {
      ctx.logger.warn(
        `  [hook] message_normalizer.onAfterApply: guard "${sentinel}" did not land at the normalizer head (left-neighbour: ${JSON.stringify(window.slice(-60))})`,
      );
    }
  },
  revisit: {
    addedIn: '2.1.131',
    until: '2.2.0',
    note: 'Forensic guard for unhandled display-item types and renamed normalizer fn. Re-check whether upstream now handles grouped_tool_use/collapsed_read_search natively.',
  },
  apply(code) {
    let result = code;

    // First patch: null-element + missing-.message guards on the display-item
    // normalizer. Function name AND param name vary across versions — capture both.
    const m = result.match(guardRe);
    if (m) {
      const fn = m[1];
      const p = m[2]; // minified parameter name (H historically, e in v2.1.185+)
      const anchor = `function ${fn}(${p}){if(${p}.type==="progress"||${p}.type==="attachment"||${p}.type==="system")return!0;if(typeof ${p}.message.content`;
      const replacement = `function ${fn}(${p}){if(!${p})return!1;if(${p}.type==="progress"||${p}.type==="attachment"||${p}.type==="system")return!0;if(!${p}.message)return!0;if(typeof ${p}.message.content`;
      result = result.replace(anchor, replacement);
      ccpLog(`  [+] message_normalizer: ${fn}() null-element and missing-.message guards (param=${p})`);
    } else {
      console.warn(`  [!] message_normalizer: display-item normalizer anchor not found — skipping`);
    }

    // Second patch: null/undefined content guard before .length — also param-dynamic.
    if (m) {
      const p = m[2];
      const name = "null/undefined content guard before .length";
      const anchor = `if(typeof ${p}.message.content==="string")return ${p}.message.content.trim().length>0;if(${p}.message.content.length===0)`;
      const replacement = `if(typeof ${p}.message.content==="string")return ${p}.message.content.trim().length>0;if(!${p}.message.content)return!1;if(${p}.message.content.length===0)`;
      if (!result.includes(anchor)) {
        console.warn(`  [!] message_normalizer: "${name}" anchor not found — skipping`);
      } else {
        result = result.replace(anchor, replacement);
        ccpLog(`  [+] message_normalizer: ${name}`);
      }
    }

    return result;
  },
};

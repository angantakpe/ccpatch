// Upstream breakage in v2.1.131: new display item types (grouped_tool_use,
// collapsed_read_search) produced by cq4()/dQ7() hit unguarded paths in
// zr_() and RY$(). These three substitutions harden those paths.
// v2.1.132: fs_() default case also returns bare H instead of [H], causing
// _.push(...H) to throw a spread-iterator TypeError for unknown message types.
// v2.1.133: zr_/fs_ renamed to xt_; en7 renamed to Ii7; RY$ renamed to Af$.
// The display-item normalizer function name has drifted across versions:
// Af$ (<=v2.1.137), h3$ (<=v2.1.144), bP$ (v2.1.145), cW$ (v2.1.146+).
// Capture the name with a regex; the body shape is stable.
const guardRe = /function ([A-Za-z_$][\w$]*)\(H\)\{if\(H\.type==="progress"\|\|H\.type==="attachment"\|\|H\.type==="system"\)return!0;if\(typeof H\.message\.content/;

const literalPatches = [
  {
    name: "null/undefined content guard before .length",
    anchor:
      'if(typeof H.message.content==="string")return H.message.content.trim().length>0;if(H.message.content.length===0)',
    replacement:
      'if(typeof H.message.content==="string")return H.message.content.trim().length>0;if(!H.message.content)return!1;if(H.message.content.length===0)',
  },
];

export default {
  category: 'fix',

  description:
    "Guard zr_() default case and RY$() against v2.1.131 display item types.",
  capabilities: [],
  verify: { present: 'if(!H)return!1;', weak: true },
  // Self-check after apply: the null-element guard must land *inside* the
  // display-item normalizer (right after its opening brace), not somewhere
  // else in the bundle. If the guard exists but its left-neighbour is not the
  // normalizer's opening `function NAME(H){`, something matched the wrong site.
  onAfterApply(ctx) {
    const sentinel = 'if(!H)return!1;';
    const idx = ctx.appliedCode.indexOf(sentinel);
    if (idx < 0) return; // verify will catch this
    // Look back ~120 chars for the normalizer signature; tolerate variance.
    const window = ctx.appliedCode.slice(Math.max(0, idx - 120), idx);
    if (!/function [A-Za-z_$][\w$]*\(H\)\{$/.test(window)) {
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
    // normalizer. Function name varies across versions — regex-capture it.
    const m = result.match(guardRe);
    if (m) {
      const fn = m[1];
      const anchor = `function ${fn}(H){if(H.type==="progress"||H.type==="attachment"||H.type==="system")return!0;if(typeof H.message.content`;
      const replacement = `function ${fn}(H){if(!H)return!1;if(H.type==="progress"||H.type==="attachment"||H.type==="system")return!0;if(!H.message)return!0;if(typeof H.message.content`;
      result = result.replace(anchor, replacement);
      console.log(`  [+] message_normalizer: ${fn}() null-element and missing-.message guards`);
    } else {
      console.warn(`  [!] message_normalizer: display-item normalizer anchor not found — skipping`);
    }

    for (const { name, anchor, replacement } of literalPatches) {
      if (!result.includes(anchor)) {
        console.warn(
          `  [!] message_normalizer: "${name}" anchor not found — skipping`,
        );
        continue;
      }
      result = result.replace(anchor, replacement);
      console.log(`  [+] message_normalizer: ${name}`);
    }
    return result;
  },
};

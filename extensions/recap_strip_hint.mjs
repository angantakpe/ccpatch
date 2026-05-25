/**
 * recap_strip_hint — Remove the "(disable recaps in /config)" hint that CC
 * appends to the first 3 away-summary recaps.
 *
 * Native CC adds this one-time educational hint:
 *   let b=I.text, F=Y.current<3?`${b} (disable recaps in /config)`:b;
 *
 * We replace it so F is always just b — the plain recap text.
 *
 * ANCHOR: the literal string "(disable recaps in /config)" is stable and
 * unique. No regex needed — simple string replacement.
 */

export default {
  category: 'fix',

  description: 'Remove the (disable recaps in /config) hint from away-summary recaps',
  capabilities: ["prompt"],
  verify: { absent: '(disable recaps in /config)' },
  apply: (code) => {
    // Anchor: the ternary that conditionally appends the hint
    // Shape: <F>=<Y>.current<3?`${<b>} (disable recaps in /config)`:<b>;
    // We replace the whole ternary RHS with just the plain text variable.
    const anchorRe = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.current<3\?`\$\{([A-Za-z_$][\w$]*)\} \(disable recaps in \/config\)`:\3;/;
    const m = code.match(anchorRe);
    if (!m) {
      console.warn('  [!] recap_strip_hint: hint anchor not found — recap hint stays');
      return code;
    }
    // m[1] = F  m[2] = Y  m[3] = b
    const replacement = `${m[1]}=${m[3]};`;
    const patched = code.replace(anchorRe, replacement);
    if (patched === code) {
      console.warn('  [!] recap_strip_hint: replacement had no effect');
      return code;
    }
    console.log(`  [recap_strip_hint] removed recap hint (F=${m[1]}, Y=${m[2]}, b=${m[3]})`);
    return patched;
  },
};

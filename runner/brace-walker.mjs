// runner/brace-walker.mjs
//
// Single source of truth for matching-brace lookup over JavaScript source.
//
// The three previous copies (runner/ast-anchor.mjs, runner/patch-kinds.mjs,
// runner/at-selector.mjs) all handled '"', "'", '`', and '//' but none of
// them skipped '/* */' block comments. A minified bundle is unlikely to
// contain block comments, but the JSDoc-style /** */ headers on injected
// patch source CAN reach the walker via transpiler kinds — and a stray
// '{' or '}' inside a block comment would corrupt the depth counter.
//
// Behaviour: skip string literals (single, double, template — with simple
// backslash-escape handling), single-line `// ...` comments, and block
// `/* ... */` comments. Template interpolation `${...}` is not parsed as
// nested code — that's deliberate, matching the prior behaviour, since
// the bundle is minified and template-literal expressions are rare. If
// that ever changes, this is the single place to fix it.

/**
 * Find the position of the closing `}` that matches the opening `{` at
 * `openPos` in `code`.
 *
 * @param {string} code     - Source text to scan.
 * @param {number} openPos  - Index of the opening `{` in `code`.
 * @returns {number} Index of the matching `}`, or -1 if unbalanced.
 */
export function findClosingBrace(code, openPos) {
  let depth = 1;
  let i = openPos + 1;
  const len = code.length;
  while (i < len && depth > 0) {
    const c = code[i];
    if (c === '"' || c === "'") {
      // Single or double-quoted string literal.
      i++;
      while (i < len) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '`') {
      // Template literal. We don't recurse into ${...} expressions because
      // (a) the bundle is minified and rarely contains them and (b) it
      // would require a real tokenizer. Treat the whole thing as opaque.
      i++;
      while (i < len) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      // Single-line comment.
      const nl = code.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      // Block comment.
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

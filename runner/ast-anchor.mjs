// runner/ast-anchor.mjs
import * as acorn from 'acorn';

/**
 * Find the innermost named function in `code` whose body contains `literal`
 * as a string argument.
 *
 * Why no regex: minifiers rotate variable names but cannot rename string
 * literals. Anchoring on the literal and extracting the enclosing function
 * via brace counting + Acorn parse gives AST-level confidence without
 * parsing the full 16MB bundle.
 *
 * @param {string} code    - Full bundle source
 * @param {string} literal - Stable string literal to search for (without quotes)
 * @returns {{ name: string|null, start: number, end: number } | null}
 *   start: offset of 'function' keyword in code
 *   end:   offset after the closing '}' of that function
 */
export function findFunctionByLiteral(code, literal) {
  const needle = JSON.stringify(literal); // adds quotes + escaping
  let searchFrom = 0;

  while (searchFrom < code.length) {
    const litIdx = code.indexOf(needle, searchFrom);
    if (litIdx === -1) return null;

    // Scan backward for nearest 'function' keyword before the literal.
    const windowStart = Math.max(0, litIdx - 400);
    const back = code.slice(windowStart, litIdx);
    const relFnKw = back.lastIndexOf('function ');
    if (relFnKw === -1) { searchFrom = litIdx + 1; continue; }
    const fnStart = windowStart + relFnKw;

    // Find the opening brace of the function body (skip name + params).
    const openBrace = code.indexOf('{', fnStart + 8);
    if (openBrace === -1 || openBrace > litIdx) { searchFrom = litIdx + 1; continue; }

    // Find the matching closing brace.
    const closePos = findClosingBrace(code, openBrace);
    if (closePos === -1 || litIdx > closePos) { searchFrom = litIdx + 1; continue; }

    // Parse the extracted function text with Acorn to validate structure and get the name.
    const fnText = code.slice(fnStart, closePos + 1);
    let name = null;
    try {
      const ast = acorn.parse(`(${fnText})`, {
        ecmaVersion: 'latest',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
      });
      const expr = ast.body[0]?.expression;
      if (expr && (expr.type === 'FunctionExpression' || expr.type === 'FunctionDeclaration')) {
        name = expr.id?.name ?? null;
      }
      // If Acorn parsed it but it's not a function expression, skip this hit.
      if (!expr || (expr.type !== 'FunctionExpression' && expr.type !== 'FunctionDeclaration')) {
        searchFrom = litIdx + 1;
        continue;
      }
    } catch (_) {
      // Parse failed — try a quick regex fallback to extract the name.
      const nm = fnText.match(/^function\s*([\w$]+)\s*\(/);
      name = nm?.[1] ?? null;
      // If we can't even get a name, skip this hit.
      if (!name) { searchFrom = litIdx + 1; continue; }
    }

    return { name, start: fnStart, end: closePos + 1 };
  }
  return null;
}

/**
 * Find the position of the closing brace that matches the opening brace at
 * `openPos` in `code`. Correctly skips string literals (single, double, template)
 * and single-line comments so brace counts are not confused by `{` or `}` inside
 * strings or comments.
 *
 * @param {string} code
 * @param {number} openPos - index of the opening `{`
 * @returns {number} index of the matching `}`, or -1 if not found
 */
function findClosingBrace(code, openPos) {
  let depth = 1;
  let i = openPos + 1;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '"' || c === "'") {
      // Skip string literal.
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '`') {
      // Skip template literal (no nested ${ handling needed for minified code).
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      // Skip single-line comment.
      const nl = code.indexOf('\n', i + 2);
      i = nl === -1 ? code.length : nl + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

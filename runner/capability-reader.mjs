/**
 * capability-reader.mjs — read a patch file's `capabilities` array without
 * fully executing the module in the main process.
 *
 * Strategy:
 *   Option A (preferred): run the source text in a vm sandbox with a heavily
 *     restricted context. Only `module.exports` / `exports` are provided; any
 *     attempt to call `require` throws. A 500 ms timeout guards against loops.
 *   Option B (fallback): if the vm run throws for any reason, fall back to a
 *     static regex scan that extracts the capabilities array from source text
 *     without executing anything.
 *
 * Both paths return string[] (or [] when the field is absent or non-array).
 * Errors are logged as warnings; they never propagate — a bad patch file just
 * returns [].
 */

import fs from 'node:fs';
import vm from 'node:vm';

/**
 * Read the `capabilities` array from a patch file without doing a full import.
 *
 * @param {string} patchFilePath  absolute path to the .mjs patch file
 * @returns {string[]}            declared capabilities (may be empty)
 */
export function readPatchCapabilities(patchFilePath) {
  let source;
  try {
    source = fs.readFileSync(patchFilePath, 'utf8');
  } catch (err) {
    // File missing or unreadable — return nothing.
    console.warn(`[capability-reader] cannot read ${patchFilePath}: ${err.message}`);
    return [];
  }

  // ── Option A: vm sandbox ────────────────────────────────────────────────────
  try {
    return readViaVm(source, patchFilePath);
  } catch (vmErr) {
    console.warn(
      `[capability-reader] vm sandbox failed for ${patchFilePath} (falling back to regex): ${vmErr.message}`,
    );
  }

  // ── Option B: static regex fallback ─────────────────────────────────────────
  return readViaRegex(source);
}

// ─────────────────────────────────────────────────────────────────────────────
// Option A implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute source in a restricted vm context and extract capabilities.
 * Throws on any error — the caller catches and falls back to Option B.
 */
function readViaVm(source, filePath) {
  // Patch files are ES modules (export default { ... }). The vm module does
  // not support ES module syntax natively with runInNewContext, so we rewrite
  // the `export default` statement to a CommonJS-style assignment before
  // running. This is intentionally narrow: only the default export assignment
  // is rewritten; any other ESM syntax (import) will still throw, which is
  // fine — we catch and fall back.
  const cjsSource = toCommonJs(source);

  const moduleObj = { exports: {} };
  const sandbox = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: () => { throw new Error('no require in sandbox'); },
    // Provide a minimal console so patches that happen to log at the top
    // level don't crash the sandbox.
    console: { log: () => {}, warn: () => {}, error: () => {} },
  });

  vm.runInContext(cjsSource, sandbox, {
    filename: filePath,
    timeout: 500,
  });

  // The default export may have landed on module.exports or exports.default.
  const exported =
    (moduleObj.exports && moduleObj.exports.__esModule && moduleObj.exports.default !== undefined)
      ? moduleObj.exports.default
      : moduleObj.exports;

  const caps = exported?.capabilities;
  if (!Array.isArray(caps)) return [];
  return caps.filter(c => typeof c === 'string');
}

/**
 * Rewrite ES module `export default <expr>` to a CJS assignment so the source
 * can run in vm.runInContext (which uses a CommonJS-like context).
 *
 * Only handles the single `export default` pattern used by ccpatch patches.
 * All other ESM syntax (import, named exports) is left as-is; if the vm
 * chokes on it Option B takes over.
 */
function toCommonJs(source) {
  // Replace `export default` with `module.exports =`.
  // Use a greedy replace only on the first occurrence (patches have exactly one).
  return source.replace(/^\s*export\s+default\s+/m, 'module.exports = ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Option B implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan source text with a regex and extract the capabilities array contents
 * without executing any code. Returns [] on no match.
 */
function readViaRegex(source) {
  // Match:  capabilities: ['a', "b", ...]
  // The regex captures everything between the brackets (non-greedy won't span
  // newlines well, so we use [^\]] which is safe for typical single-line arrays).
  const match = /capabilities\s*:\s*\[([^\]]*)\]/.exec(source);
  if (!match) return [];

  const inner = match[1];
  const values = [];
  // Extract all quoted strings inside the brackets.
  const strPat = /['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = strPat.exec(inner)) !== null) {
    values.push(m[1]);
  }
  return values;
}

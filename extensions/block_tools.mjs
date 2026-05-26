
export default {
    category: 'optional',
    enabled: false,

    description: 'Block specific tools from being used',
    capabilities: ["env","tools"],
    verify: { present: '__isToolBlocked__', weak: true },
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Tool Blocker
// ══════════════════════════════════════════════════════════════════════════

// Tools to block (customize this list)
const BLOCKED_TOOLS = new Set([
  // 'Bash',      // Block shell commands
  // 'Write',     // Block file writes
  // 'Delete',    // Block file deletes
  'ComposioSearch',      // Use mcp__composio__COMPOSIO_SEARCH_TOOLS instead
  'ComposioExecuteTool', // Use mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL instead
]);

globalThis.__isToolBlocked__ = (toolName) => {
  if (BLOCKED_TOOLS.has(toolName)) {
    console.log('[BLOCKED] Tool blocked by patch:', toolName);
    return true;
  }
  return false;
};

// Wire: intercept Array.prototype.find to return a blocking wrapper for blocked tools.
// Strict predicate: only triggers on real tool-definition arrays, never on Ink/React
// internal arrays. Uses hasOwnProperty (not 'in') so Function.prototype.call inheritance
// can't false-match. Requires inputSchema to be an actual object. Entire override is
// gated on BLOCKED_TOOLS.size > 0 — no-op when nothing is blocked.
const __blockHasOwn__ = Object.prototype.hasOwnProperty;
const __blockIsTools__ = (a) => {
  if (!Array.isArray(a) || a.length === 0) return false;
  const first = a[0];
  if (!first || typeof first !== 'object') return false;
  if (typeof first.name !== 'string') return false;
  // Real tool defs have an own 'inputSchema' that is a non-null object,
  // OR an own 'call' that is a function. Inherited Function.prototype.call
  // does NOT pass hasOwnProperty.
  const hasInputSchema = __blockHasOwn__.call(first, 'inputSchema')
    && first.inputSchema && typeof first.inputSchema === 'object';
  const hasOwnCall = __blockHasOwn__.call(first, 'call')
    && typeof first.call === 'function';
  return hasInputSchema || hasOwnCall;
};
if (BLOCKED_TOOLS.size > 0) {
  const __blockFindOrig__ = Array.prototype.find;
  Array.prototype.find = function(predicate, thisArg) {
    const result = __blockFindOrig__.call(this, predicate, thisArg);
    if (__blockIsTools__(this) && result && typeof result === 'object' && result.name && globalThis.__isToolBlocked__?.(result.name)) {
      return {
        ...result,
        call: async () => ({ data: \`Tool '\${result.name}' is blocked by ccpatch.\` }),
        isEnabled: () => false,
      };
    }
    return result;
  };
}

`;
      return code.replace('(function(exports, require, module, __filename, __dirname) {', '(function(exports, require, module, __filename, __dirname) {' + hook);
    }
  };

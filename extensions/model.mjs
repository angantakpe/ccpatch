
export default {
    category: 'optional',
    enabled: false,

    description: 'Change the default model when an explicit override is supplied',
    capabilities: ["env","network"],
    // count: exactly one of the two branches (Model Override / Model Sync) is
    // injected, each containing a single '[PATCH] Model' banner == 1 occurrence.
    verify: { present: '[PATCH] Model', count: { present: 1 } },
    apply: (code, options = {}) => {
      const model = options.model || null;
      const modelHook = model
        ? `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Model Override
// ══════════════════════════════════════════════════════════════════════════
if (!process.env.ANTHROPIC_MODEL) {
  process.env.ANTHROPIC_MODEL = '${model}';
}

`
        : `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Model Sync
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (process.env.ANTHROPIC_MODEL) return;
  const display = String(process.env.CLAUDE_MODEL_DISPLAY || process.env.CLAUDE_MODEL || '').trim().toLowerCase();
  if (!display) return;
  const modelIds = {
    'opus': 'claude-opus-4-8',
    'opus 4.8': 'claude-opus-4-8',
    'opus 4.7': 'claude-opus-4-7',
    'opus 4.6': 'claude-opus-4-6',
    'sonnet': 'claude-sonnet-4-6',
    'sonnet 4.6': 'claude-sonnet-4-6',
    'sonnet 4.5': 'claude-sonnet-4-5',
    'haiku': 'claude-haiku-4-5-20251001',
    'haiku 4.5': 'claude-haiku-4-5-20251001',
  };
  process.env.ANTHROPIC_MODEL = modelIds[display] || process.env.CLAUDE_MODEL || process.env.CLAUDE_MODEL_DISPLAY;
})();

`;
    const _CJS_IIFE = '(function(exports, require, module, __filename, __dirname) {';
    if (code.startsWith('#!/usr/bin/env node')) {
      return code.replace('#!/usr/bin/env node', '#!/usr/bin/env node' + modelHook);
    } else if (code.includes(_CJS_IIFE)) {
      return code.replace(_CJS_IIFE, () => _CJS_IIFE + modelHook);
    } else {
      console.warn('  [!] anchor not found (no shebang, no CJS-IIFE) — skipping');
      return code;
    }
    }
  };

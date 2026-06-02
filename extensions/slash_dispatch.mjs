export default {
  category: 'infrastructure',

  description: 'Intercept /slash-commands in UserPromptSubmit — dispatch via __ccpDispatchSlash registry',
  capabilities: ["prompt"],
  verify: { present: '__ccpSlashDispatchInstalled', count: { present: 1 } },
  dependsOn: ['custom_commands'],
  allowOverlapWith: ['custom_commands'],
  apply: (code) => {
    const marker = '__ccpSlashDispatchInstalled';
    if (code.includes(marker)) {
      console.warn('  [!] slash_dispatch: already applied — skipping');
      return code;
    }

    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Slash Command Dispatch (OSS core)
// Intercepts UserPromptSubmit events, checks for /command syntax, and
// dispatches via globalThis.__ccpDispatchSlash (from custom_commands).
// Non-slash inputs fall through unchanged.
//
// Subscription contract:
//   The host (or another patch) must publish globalThis.__ccpOnUserPromptSubmit
//   as a function (fn) => void that registers fn as a UserPromptSubmit listener.
//   Tier 3 patches may wrap __ccpDispatchSlash to inject additional behavior.
// ══════════════════════════════════════════════════════════════════════════
var ${marker} = true;
(function() {
  async function _handleSubmit(event) {
    try {
      var input = event && (event.input || event.prompt || event.text || '');
      if (typeof input !== 'string' || !input.trim().startsWith('/')) return;

      var _dispatch = globalThis.__ccpDispatchSlash;
      if (typeof _dispatch !== 'function') return;

      var result = _dispatch(input);
      if (result && typeof result.then === 'function') {
        result = await result;
      }

      if (result === true) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        else event._ccpHandled = true;
        return;
      }
      if (result && typeof result === 'object' && result.handled) {
        if (result.output) console.log(result.output);
        if (result.type === 'replace' && typeof result.newPrompt === 'string') {
          if (event.input !== undefined)  event.input  = result.newPrompt;
          if (event.prompt !== undefined) event.prompt = result.newPrompt;
          if (event.text !== undefined)   event.text   = result.newPrompt;
          return;
        }
        if (typeof event.preventDefault === 'function') event.preventDefault();
        else event._ccpHandled = true;
      }
    } catch (_e) {
      // Non-fatal — allow the prompt to pass through on any error
    }
  }

  function _installSlashDispatch() {
    var _onSubmit = globalThis.__ccpOnUserPromptSubmit;
    if (typeof _onSubmit !== 'function') return false;
    _onSubmit(_handleSubmit);
    return true;
  }

  if (!_installSlashDispatch()) {
    var _retries = 0;
    var _t = setInterval(function() {
      if (_installSlashDispatch() || ++_retries > 50) clearInterval(_t);
    }, 100);
  }
})();

`;

    const _CJS_IIFE = '(function(exports, require, module, __filename, __dirname) {';
    if (code.startsWith('#!/usr/bin/env node')) {
      return code.replace('#!/usr/bin/env node', '#!/usr/bin/env node' + hook);
    } else if (code.includes(_CJS_IIFE)) {
      return code.replace(_CJS_IIFE, () => _CJS_IIFE + hook);
    } else {
      console.warn('  [!] anchor not found (no shebang, no CJS-IIFE) — skipping');
      return code;
    }
  }
};

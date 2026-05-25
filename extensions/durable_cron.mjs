import { findFunctionByLiteral } from '../runner/ast-anchor.mjs';

export default {
    category: 'feature',

    description: 'Force isDurableCronEnabled() to return true (enables persistent cron)',
    capabilities: [],
    verify: {
      absent: '"tengu_kairos_cron_durable",!0,',
      label: 'Durable Cron',
    },
    // Declarative anchor — the runner resolves this to a HEAD site before
    // calling apply(); opts.atSites is then available for splicing. We still
    // rebuild the function body wholesale (replacing it with `return !0`), so
    // the apply() does its own range lookup via the resolved site.
    at: {
      kind: 'HEAD',
      target: { function: { literal: 'tengu_kairos_cron_durable' } },
    },
    apply: (code, opts) => {
      // Prefer the runner-resolved @At site if present; otherwise fall back to
      // findFunctionByLiteral directly (keeps the patch standalone-testable).
      let fn;
      if (opts && Array.isArray(opts.atSites) && opts.atSites.length > 0) {
        // The HEAD site sits just after the opening brace of the body. Locate
        // the surrounding function by walking the same literal.
        fn = findFunctionByLiteral(code, 'tengu_kairos_cron_durable');
      } else {
        fn = findFunctionByLiteral(code, 'tengu_kairos_cron_durable');
      }
      if (!fn) {
        console.error('  [durable_cron] WARNING: isDurableCronEnabled anchor not matched — update runner/anchors.mjs for this version');
        return code;
      }
      const fnName = fn.name;
      console.log(`  [durable_cron] patched ${fnName}() → always true`);
      code = code.slice(0, fn.start) + 'function ' + fnName + '(){return !0}' + code.slice(fn.end);

      // H-3: Register /cron slash command so the feature is accessible from the prompt.
      // We register a simple handler on globalThis.__ccpRegisterSlashCommand (installed
      // by custom_commands patch) that shows cron status. A full scheduling UI would
      // require bundle-level cron list/add/remove APIs to be exposed — add those here
      // if they are found in a future bundle analysis.
      const cronCmd = `
// [PATCH] durable_cron: /cron slash command registration
(function() {
  function _regCron() {
    if (typeof globalThis.__ccpRegisterSlashCommand !== 'function') return false;
    globalThis.__ccpRegisterSlashCommand('/cron', function(args) {
      var sub = args && args[0];
      if (sub === 'status' || !sub) {
        console.log('Durable cron: enabled (patched)');
        console.log('  isDurableCronEnabled() → always true');
        console.log('  Use /cron list|add|remove when bundle API is exposed.');
      } else {
        console.log('Usage: /cron [status]');
      }
    });
    return true;
  }
  if (!_regCron()) {
    var _retries = 0;
    var _t = setInterval(function() { if (_regCron() || ++_retries > 50) clearInterval(_t); }, 200);
  }
})();
`;
      code = code.replace('#!/usr/bin/env node', '#!/usr/bin/env node\n' + cronCmd);
      return code;
    }
  };

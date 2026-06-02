import { forceFeatureFlag, spliceAfter } from '../runner/patch-helpers.mjs';
import { resolveAnchorLiteral } from '../runner/anchors.mjs';

const SHEBANG = '#!/usr/bin/env node';

// Resolve the stable feature-flag literal from the central registry rather than
// re-typing it here — the registry (runner/anchors.mjs) is the single home for
// the "isDurableCronEnabled" anchor, the same way loop_dynamic resolves its
// literals. A version bump only ever edits the registry.
const CRON_FLAG_LITERAL = resolveAnchorLiteral('isDurableCronEnabled');

export default {
    category: 'feature',

    description: 'Force isDurableCronEnabled() to return true (enables persistent cron)',
    capabilities: [],
    verify: {
      absent: '"tengu_kairos_cron_durable",!0,',
      label: 'Durable Cron',
    },
    // Declarative anchor — the runner resolves this to a HEAD site before
    // calling apply(). forceFeatureFlag re-walks the same literal to find the
    // enclosing function and rewrites its body to `return !0`, sharing the
    // override logic with the other feature-flag patches.
    at: {
      kind: 'HEAD',
      target: { function: { literal: CRON_FLAG_LITERAL } },
    },
    apply: (code) => {
      const res = forceFeatureFlag(code, CRON_FLAG_LITERAL, { allowMissing: true });
      if (!res.fnName) {
        console.error('  [durable_cron] WARNING: isDurableCronEnabled anchor not matched — update runner/anchors.mjs for this version');
        return code;
      }
      code = res.code;
      console.log(`  [durable_cron] patched ${res.fnName}() → always true`);

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
      // Register the /cron command before any bundle code runs. Prefer a real
      // leading shebang (startsWith, NOT spliceAfter's indexOf — Bun-extracted
      // bundles carry "#!/usr/bin/env node" as an interior string literal that
      // indexOf would wrongly match, splicing into dead string content). When
      // there's no leading shebang, anchor inside the CJS-IIFE body instead.
      if (code.startsWith(SHEBANG)) {
        return spliceAfter(code, SHEBANG, '\n' + cronCmd, { allowMissing: true });
      }
      const IIFE = '(function(exports, require, module, __filename, __dirname) {';
      if (code.includes(IIFE)) {
        return code.replace(IIFE, () => IIFE + '\n' + cronCmd);
      }
      return code;
    }
  };

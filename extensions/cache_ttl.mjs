
export default {
    category: 'fix',

    description: 'Fix: 1h prompt-cache TTL always used for eligible users (telemetry toggle no longer degrades to 5min)',
    capabilities: [],
    verify: {
      absent: '"repl_main_thread*","sdk","auto_mode"',
      label: 'Fix Cache TTL (1h)',
    },
    apply: (code) => {
      // DoY() decides whether to stamp ttl:"1h" on cache_control objects.
      // Bug: after passing the o7() auth check it consults a GrowthBook feature
      // flag via b8("tengu_prompt_cache_1h_config",...).  That flag is never
      // fetched when telemetry is disabled (za()/B26() chain), so b8() falls
      // back to a narrow hardcoded allowlist that misses hook_agent /
      // verification_agent / agent:* querySource values → 5-min TTL.
      // Fix: once o7() passes, skip the feature-flag gate and always return true.
      //
      // Anchor: "tengu_prompt_cache_1h_config" is stable across versions.
      // Full old tail of DoY:
      //   let K=s61();if(K===null)K=b8("tengu_prompt_cache_1h_config",{allowlist:[...]}).allowlist??[],t61(K);
      //   return q!==void 0&&K.some((_)=>_.endsWith("*")?q.startsWith(_.slice(0,-1)):q===_)
      // v2.1.114+: minified identifiers may include $ (e.g. the variable is literally named "$").
      // Use [\w$]+ instead of \w+ so dollar-sign variable names match.
      // Written as new RegExp to avoid JS regex literal syntax constraints on multi-line.
      const pattern = new RegExp(
        'let [\\w$]+=[\\w$]+\\(\\);if\\([\\w$]+===null\\)[\\w$]+=[\\w$]+\\("tengu_prompt_cache_1h_config",' +
        '\\{allowlist:\\["repl_main_thread\\*","sdk","auto_mode"(?:,"memdir_relevance")?\\]\\}\\)\\.allowlist\\?\\?\\[\\],[\\w$]+\\([\\w$]+\\);' +
        'return [\\w$]+!==void 0&&[\\w$]+\\.some\\(\\([\\w$]+\\)=>[\\w$]+\\.endsWith\\("\\*"\\)\\?' +
        '[\\w$]+\\.startsWith\\([\\w$]+\\.slice\\(0,-1\\)\\):[\\w$]+===[\\w$]+\\)\\}'
      );
      const match = code.match(pattern);
      if (!match) {
        console.error('  [cache_ttl] WARNING: DoY feature-flag tail not found — pattern may have changed. Patch skipped.');
        return code;
      }
      const fixed = code.replace(match[0], 'return!0}');
      console.log('  [cache_ttl] patched DoY() → always 1h TTL for eligible users (feature-flag gate removed)');
      return fixed;
    }
  };

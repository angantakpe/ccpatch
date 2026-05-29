// Manifest fields added per patch-manifest contract (docs/cli-bundle/patch-manifest.md)

export default {
  name: 'hook_noise_mute',
  version: '1.0.0',
  category: 'infrastructure',
  description: 'Mute known hook noise from tool output (ugrep bad-option lines, rtk rewrite chatter)',
  capabilities: ["exec"],
  // count: the injected hook reads cp.__ccpNoiseMuted once (guard) and sets it
  // once == 2 occurrences after a correct apply.
  verify: { present: '__ccpNoiseMuted', count: { present: 2 } },
  dependsOn: [],
  applyMode: 'either',
  anchor: { literal: '(function(exports, require, module, __filename, __dirname)' },

  apply: (code) => {
    // Wrap child_process.spawnSync globally so hook stderr is filtered before
    // it reaches the TUI. Version-resilient: no minified-name dependencies.
    const patch = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Hook Noise Mute — filter known noisy hook stderr lines
// ══════════════════════════════════════════════════════════════════════════
(function() {
  try {
    var _cp = require('node:child_process');
    if (_cp.__ccpNoiseMuted) return;
    _cp.__ccpNoiseMuted = true;

    // Lines matching these patterns are dropped from hook stderr output.
    // Add patterns here when new noise sources appear.
    var NOISE_PATTERNS = [
      /^ugrep: bad option/,
      /^ugrep: use --help/,
      /^ugrep: invalid/,
      /^\\[rtk\\] /,
      /^\\[skill-activation\\] /,
      /^\\[smart-router\\] /,
      /^\\[route-and-execute\\] /,
    ];

    function _filterStderr(buf) {
      if (!buf) return buf;
      var s = buf.toString ? buf.toString('utf8') : String(buf);
      var filtered = s.split('\\n').filter(function(line) {
        return !NOISE_PATTERNS.some(function(re) { return re.test(line); });
      }).join('\\n');
      return filtered === s ? buf : Buffer.from(filtered, 'utf8');
    }

    var _origSpawnSync = _cp.spawnSync;
    _cp.spawnSync = function spawnSyncMuted() {
      var r = _origSpawnSync.apply(this, arguments);
      if (r && r.stderr) r = Object.assign({}, r, { stderr: _filterStderr(r.stderr) });
      return r;
    };

    var _origExecFileSync = _cp.execFileSync;
    _cp.execFileSync = function execFileSyncMuted() {
      try { return _origExecFileSync.apply(this, arguments); }
      catch (err) {
        if (err && err.stderr) err.stderr = _filterStderr(err.stderr);
        throw err;
      }
    };
  } catch(e) { /* fail open — never break the shell */ }
})();
`;

    const __shebang__ = '#!/usr/bin/env node';
    const __cjsIife__ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(__shebang__)) {
      return code.replace(__shebang__, __shebang__ + patch);
    } else if (code.includes(__cjsIife__)) {
      return code.replace(__cjsIife__, patch + __cjsIife__);
    }
    console.warn('  [!] hook_noise_mute: no shebang or CJS-IIFE anchor found — skipping');
    return code;
  },

  // installRuntime: called from IIFE-head at runtime (applyMode 'either').
  // Receives globalThis. Must be synchronous and wrapped in try/catch.
  installRuntime: (_globals) => {
    try {
      const cp = require('node:child_process');
      if (cp.__ccpNoiseMuted) return;
      cp.__ccpNoiseMuted = true;
      const NOISE_PATTERNS = [
        /^ugrep: bad option/,
        /^ugrep: use --help/,
        /^ugrep: invalid/,
        /^\[rtk\] /,
        /^\[skill-activation\] /,
        /^\[smart-router\] /,
        /^\[route-and-execute\] /,
      ];
      function filterStderr(buf) {
        if (!buf) return buf;
        const s = buf.toString ? buf.toString('utf8') : String(buf);
        const out = s.split('\n').filter(l => !NOISE_PATTERNS.some(re => re.test(l))).join('\n');
        return out === s ? buf : Buffer.from(out, 'utf8');
      }
      const origSpawnSync = cp.spawnSync;
      cp.spawnSync = function spawnSyncMuted() {
        const r = origSpawnSync.apply(this, arguments);
        if (r && r.stderr) return Object.assign({}, r, { stderr: filterStderr(r.stderr) });
        return r;
      };
      const origExecFileSync = cp.execFileSync;
      cp.execFileSync = function execFileSyncMuted() {
        try { return origExecFileSync.apply(this, arguments); }
        catch (err) { if (err && err.stderr) err.stderr = filterStderr(err.stderr); throw err; }
      };
    } catch (e) { /* fail open */ }
  },
};

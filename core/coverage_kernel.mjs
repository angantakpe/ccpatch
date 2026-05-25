/**
 * coverage_kernel — Runtime coverage counter for ccpatch patches.
 *
 * ── Problem ──────────────────────────────────────────────────────────────────
 * A patch's anchor can resolve and apply() cleanly, yet the injected code
 * never actually executes — a feature flag turns it off, or the surrounding
 * branch is dead in the current CC version. Pure apply-time verification
 * cannot detect this; the patch ships forever as silent dead code.
 *
 * ── Solution ─────────────────────────────────────────────────────────────────
 * Install a tiny coverage map on globalThis before any patch code runs. Each
 * patch that opts in by declaring `coverageMarker: 'name'` in its manifest
 * gets a `__ccpCovHit('name')` call automatically injected at its `at` site
 * (or at the first line of its injection). At runtime, hitting the marker
 * increments the counter under that name.
 *
 * The `ccpatch coverage` command dumps the map on SIGTERM and cross-references
 * it with the apply-time manifest, reporting any patch that applied but never
 * ran as DEAD — a signal for the maintainer to revisit or delete.
 *
 * ── Ordering ─────────────────────────────────────────────────────────────────
 * Same anchor strategy as `contracts`: prepend at the shebang or CJS-IIFE. The
 * helpers are exposed via the contracts registry so consumers can resolve them
 * via __ccpRequire('cov').
 */

const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] coverage_kernel — runtime hit counter for instrumented patches
// ══════════════════════════════════════════════════════════════════════════

if (!globalThis.__ccpCoverage) {
  globalThis.__ccpCoverage = Object.create(null);

  globalThis.__ccpCovHit = function __ccpCovHit(name) {
    if (typeof name !== 'string' || name.length === 0) return;
    var cur = globalThis.__ccpCoverage[name];
    globalThis.__ccpCoverage[name] = (typeof cur === 'number' ? cur : 0) + 1;
  };

  // Register through the contracts kernel so consumers can __ccpRequire('cov').
  // Self-bootstrap if the contracts kernel hasn't run yet (defensive: order is
  // best-effort because both patches prepend at the same anchor).
  try {
    if (typeof globalThis.__ccpProvide === 'function') {
      globalThis.__ccpProvide('cov', {
        version: 1,
        producer: 'coverage_kernel',
        shape: ['hit'],
        value: { hit: globalThis.__ccpCovHit, map: globalThis.__ccpCoverage },
      });
    }
  } catch (_) { /* contracts kernel may load after us — non-fatal */ }

  // SIGTERM dump protocol: when 'ccpatch coverage' sends SIGTERM, write the
  // coverage map as a single JSON line to stdout prefixed with __CCP_COV__.
  // The parent harness greps this prefix out of the captured stdout.
  try {
    if (typeof process !== 'undefined' && process && typeof process.on === 'function') {
      var __ccpDumpCov = function () {
        try {
          var payload = '__CCP_COV__' + JSON.stringify(globalThis.__ccpCoverage) + '\\n';
          if (process.stdout && typeof process.stdout.write === 'function') {
            process.stdout.write(payload);
          }
        } catch (_) {}
      };
      process.on('SIGTERM', function () { __ccpDumpCov(); process.exit(0); });
      // Also dump on normal exit so non-interactive smokes ('--version') still
      // emit a coverage line without needing a signal.
      process.on('exit', function () { __ccpDumpCov(); });
    }
  } catch (_) { /* non-fatal */ }
}

`;

export default {
  category: 'infrastructure',
  description: 'Runtime patch-coverage counter (globalThis.__ccpCoverage).',
  capabilities: [],
  phase: 'pre',
  // Run after contracts so __ccpProvide is installed before we register 'cov'.
  dependsOn: ['contracts'],
  verify: {
    present: 'globalThis.__ccpCoverage = Object.create(null)',
    count: { present: 1 },
  },
  preload: true,
  preloadCode: hook,
  // Best-effort: do not fail the build if this can't apply.
  required: false,
  apply: (code) => {
    const __shebang__ = '#!/usr/bin/env node';
    const __cjsIife__ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes('globalThis.__ccpCoverage = Object.create(null)')) return code;
    if (code.includes(__shebang__)) {
      return code.replace(__shebang__, () => __shebang__ + hook);
    } else if (code.includes(__cjsIife__)) {
      return code.replace(__cjsIife__, () => hook + __cjsIife__);
    }
    return code;
  },
};

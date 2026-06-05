// API contract: see EXTENSIONS_API.md -- breaking changes to __ccp* require a minor version bump.
/**
 * contracts — Typed contract registry for __ccp* globals.
 *
 * ── Problem ──────────────────────────────────────────────────────────────────
 * Build-time `verify { present: '...' }` catches whether an injection landed,
 * but not whether the resulting object SHAPE is still what consumers expect.
 * When an upstream bundle rotates internals (e.g. `client.messages` →
 * `client.beta.messages`) the producer patch may still inject successfully
 * while consumers silently get `undefined` paths.
 *
 * ── Solution ─────────────────────────────────────────────────────────────────
 * A tiny runtime registry, installed via preload before any bundle code runs,
 * with two helpers on globalThis:
 *
 *   __ccpProvide(name, { version, producer, shape?, value })
 *     Producer-side. Registers the value under `name`, recording the producing
 *     patch's identity, version, and the dotted-path shape it claims to satisfy.
 *
 *   __ccpRequire(name, { consumer, minVersion?, shape? })
 *     Consumer-side. Returns the registered value, or throws an error citing
 *     producer/version/missing-path information. The runtime equivalent of a
 *     type-check at the contract boundary.
 *
 *   __ccpInspectContracts()
 *     Debug helper. Returns [{ name, version, producer, shape }] without values.
 *
 * ── Related surface: the fetch bus error sink (advisory) ─────────────────────
 * fetch_interceptor installs the sibling __ccp* fan-out bus. A4 added a shared
 * error-reporting hook on that surface, documented here so the __ccp* contract
 * stays complete:
 *
 *   __ccpBusWarn(name, phase, err)
 *     Called by the interceptor when a fetch subscriber throws. `phase` is one
 *     of 'before' | 'stream' | 'after'. Silent unless CLAUDE_DEBUG=1 (the
 *     convention the 'debug' patch uses) or globalThis.__ccpDebug is truthy, in
 *     which case it writes one console.error line. This is advisory only — it
 *     replaces silent `catch(e){}` swallowing so buggy subscribers no longer
 *     no-op INVISIBLY; it does not alter tee/fan-out semantics or the
 *     __ccpOnFetch / __ccpOnFetchBefore / __ccpOnFetchStream registration API.
 *
 * ── ADK drift-refusal handshake (consumer) ───────────────────────────────────
 * The ccpatch ADK's capabilities() (packages/adk/index.mjs) is a CONSUMER of this
 * registry: it calls __ccpInspectContracts() and cross-checks every contracted
 * capability's advertised `version`/`shape` against the minimums it relies on
 * (swap → systemPrompt v>=2 + shape 'getNonce'; tools → toolDispatch shape
 * 'registerTool'; delegate → agentTool shape 'invoke'). A drifted host is refused
 * loudly — the matching capability boolean is downgraded to false with a reason —
 * rather than handing back a present-but-broken global. The check is advisory and
 * never throws; a capability with NO registered contract keeps its direct probe
 * result. A coarse top-level marker (globalThis.__ccpAdkContract.version) is also
 * published below so capabilities() can read a single ADK-handshake version.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Lightweight on purpose: dotted-path probes, integer versions, no schema DSL.
 * Producers MAY skip __ccpProvide and consumers MAY skip __ccpRequire — this
 * is opt-in per contract boundary. The point is to replace silent `undefined`
 * reads at producer/consumer interfaces with a single actionable error.
 *
 * ── Ordering ─────────────────────────────────────────────────────────────────
 * Like fetch_interceptor, this patch prepends at the shebang/IIFE anchor.
 * Because both patches replace the FIRST occurrence of the same anchor,
 * whichever applies LAST ends up textually FIRST in the bundle — so whichever
 * patch is last in topo order runs first at runtime. We want `contracts` to
 * run before everything else, but order-independence is achieved another way:
 * the helpers self-bootstrap on first call. Both producers and consumers can
 * call __ccpProvide / __ccpRequire even if the kernel hook hasn't run yet.
 */

const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] contracts — typed __ccp* registry (version + dotted-path shape)
// ══════════════════════════════════════════════════════════════════════════

if (!globalThis.__ccpRegistry) {
  globalThis.__ccpRegistry = new Map();

  globalThis.__ccpProvide = function __ccpProvide(name, spec) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('[ccp:contract] __ccpProvide: name must be a non-empty string');
    }
    if (!spec || typeof spec !== 'object') {
      throw new TypeError('[ccp:contract] __ccpProvide("' + name + '"): spec must be an object');
    }
    var version = (spec.version | 0) || 1;
    var producer = typeof spec.producer === 'string' && spec.producer ? spec.producer : '<unknown>';
    var shape = Array.isArray(spec.shape) ? spec.shape.slice() : [];
    var existing = globalThis.__ccpRegistry.get(name);
    if (existing && existing.producer !== producer) {
      try {
        process.stderr.write(
          '[ccp:contract] WARN: "' + name + '" already provided by "' + existing.producer +
          '" (v' + existing.version + '), overwritten by "' + producer + '" (v' + version + ')\\n'
        );
      } catch (_) {}
    }
    globalThis.__ccpRegistry.set(name, {
      name: name,
      version: version,
      producer: producer,
      shape: shape,
      value: spec.value,
    });
    return spec.value;
  };

  globalThis.__ccpRequire = function __ccpRequire(name, opts) {
    opts = opts || {};
    var consumer = typeof opts.consumer === 'string' && opts.consumer ? opts.consumer : '<unknown>';
    var minVersion = (opts.minVersion | 0) || 1;
    var probe = Array.isArray(opts.shape) ? opts.shape : [];
    var entry = globalThis.__ccpRegistry.get(name);
    if (!entry) {
      throw new Error(
        '[ccp:contract] consumer "' + consumer + '" requires contract "' + name +
        '" but no producer has registered it. Is the producing patch enabled in ccpatch.yml?'
      );
    }
    if (entry.version < minVersion) {
      throw new Error(
        '[ccp:contract] consumer "' + consumer + '" requires "' + name + '" v>=' + minVersion +
        ' but producer "' + entry.producer + '" provides v' + entry.version +
        '. Bump producer version or relax consumer minVersion.'
      );
    }
    for (var i = 0; i < probe.length; i++) {
      var path = probe[i];
      if (typeof path !== 'string' || !path) continue;
      var parts = path.split('.');
      var cur = entry.value;
      var resolved = true;
      for (var j = 0; j < parts.length; j++) {
        if (cur == null) { resolved = false; break; }
        cur = cur[parts[j]];
        if (cur === undefined) { resolved = false; break; }
      }
      if (!resolved) {
        throw new Error(
          '[ccp:contract] "' + name + '" provided by "' + entry.producer + '" (v' + entry.version +
          ') is missing required path "' + path + '" — needed by consumer "' + consumer +
          '". Producer\\u2019s anchor may have drifted; check the bundle version.'
        );
      }
    }
    return entry.value;
  };

  globalThis.__ccpInspectContracts = function __ccpInspectContracts() {
    var out = [];
    globalThis.__ccpRegistry.forEach(function(entry, name) {
      out.push({
        name: name,
        version: entry.version,
        producer: entry.producer,
        shape: entry.shape.slice(),
      });
    });
    return out;
  };

  // Coarse top-level ADK handshake marker. capabilities() (packages/adk) may read
  // globalThis.__ccpAdkContract.version as a single drift signal in addition to
  // the per-capability shape/version checks above. Advisory only — bump when the
  // __ccp* contract surface the ADK relies on changes shape incompatibly.
  if (globalThis.__ccpAdkContract === undefined) {
    globalThis.__ccpAdkContract = { version: 2 };
  }
}

`;

export default {
  category: 'infrastructure',
  description: 'Typed __ccp* contract registry (runtime version + shape checks).',
  capabilities: [],
  verify: {
    present: 'globalThis.__ccpRegistry = new Map()',
    // Registry initialiser appears exactly once in the injected hook.
    count: { present: 1 },
  },
  preload: true,
  preloadCode: hook,
  required: true,
  apply: (code) => {
    const __shebang__ = '#!/usr/bin/env node';
    const __cjsIife__ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes('globalThis.__ccpRegistry = new Map()')) return code;
    if (code.startsWith(__shebang__)) {
      return code.replace(__shebang__, () => __shebang__ + hook);
    } else if (code.includes(__cjsIife__)) {
      return code.replace(__cjsIife__, () => hook + __cjsIife__);
    }
    console.warn('  [!] contracts: no shebang or CJS-IIFE anchor found — skipping');
    return code;
  },
};

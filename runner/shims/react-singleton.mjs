import { ccpLog } from '../cli/style.mjs';

const REACT_MOD_RE_V1 = /var \w+=d\(\((\w+)\)=>\{var \w+=Symbol\.for\("react\.(?:transitional\.)?element"\)/;
const REACT_MOD_RE_V2 = /(\w+)=p\(\((\w+),\w+\)=>\{[^}]*Symbol\.for\("react\.(?:transitional\.)?element"\)/;
const REACT_MOD_RE_V3 = /var [\w$]+=\w+\(\(([\w$]+)\)=>\{var [\w$]+=Symbol\.for\("react\.(?:transitional\.)?element"\)/;

// Idempotency sentinel (rule 2): every successful branch emits it exactly once,
// so verify can `count: { present: 1 }` on a literal no OTHER patch writes
// (`globalThis.__hm_react` itself also appears in esm_compat's header, which
// made any count on it impossible to hold across composed profiles).
const SENTINEL = '__ccpReactSingleton_v1';

const REACT_UNIFY_SHIM = `
// React singleton enforcement - runtime fallback (${SENTINEL})
(function __hmReactUnify() {
  if (!globalThis.__hm_react) return;
  var _hmReactProps = ['createElement', 'createContext', 'useContext', 'useState',
    'useEffect', 'useCallback', 'useMemo', 'useRef', 'useReducer', 'useLayoutEffect',
    'useImperativeHandle', 'useDebugValue', 'forwardRef', 'memo', 'Fragment', 'Children',
    'isValidElement', 'cloneElement', 'createRef', 'lazy', 'Suspense', 'version'];
  var _hmOrigRequire = typeof __hm_nativeRequire !== 'undefined' ? __hm_nativeRequire :
                       typeof require !== 'undefined' ? require : null;
  if (_hmOrigRequire && _hmOrigRequire.cache) {
    for (var _hmKey in _hmOrigRequire.cache) {
      if (_hmKey.includes('/react/') && !_hmKey.includes('react-dom')) {
        var _hmMod = _hmOrigRequire.cache[_hmKey];
        if (_hmMod && _hmMod.exports) {
          for (var _hmProp of _hmReactProps) {
            if (globalThis.__hm_react[_hmProp]) {
              _hmMod.exports[_hmProp] = globalThis.__hm_react[_hmProp];
            }
          }
        }
      }
    }
  }
})();
`;

export function applyReactSingletonShim(code, logger = console) {
  // Idempotent re-apply: an already-shimmed bundle (any branch) carries the
  // sentinel — return it unchanged, byte-identical.
  if (code.includes(SENTINEL)) return code;

  const reactModMatchV1 = code.match(REACT_MOD_RE_V1);
  if (reactModMatchV1) {
    const [fullMatch, exportsVar] = reactModMatchV1;
    const patchedMatch = fullMatch.replace('=>{', `=>{/*${SENTINEL}*/Object.assign(${exportsVar},globalThis.__hm_react);`);
    ccpLog(`  [builtin] Bundled React module shimmed (pattern 1). (exports: ${exportsVar})`);
    return code.replace(fullMatch, patchedMatch);
  }

  const reactModMatchV2 = code.match(REACT_MOD_RE_V2);
  if (reactModMatchV2) {
    const [fullMatch, moduleVar, exportsVar] = reactModMatchV2;
    const patchedMatch = fullMatch.replace('=>{', `=>{/*${SENTINEL}*/Object.assign(${exportsVar},globalThis.__hm_react);`);
    ccpLog(`  [builtin] Bundled React module shimmed (pattern 2). (module: ${moduleVar}, exports: ${exportsVar})`);
    return code.replace(fullMatch, patchedMatch);
  }

  const reactModMatchV3 = code.match(REACT_MOD_RE_V3);
  if (reactModMatchV3) {
    const [fullMatch, exportsVar] = reactModMatchV3;
    const patchedMatch = fullMatch.replace('=>{', `=>{/*${SENTINEL}*/Object.assign(${exportsVar},globalThis.__hm_react);`);
    ccpLog(`  [builtin] Bundled React module shimmed (pattern 3). (exports: ${exportsVar})`);
    return code.replace(fullMatch, patchedMatch);
  }

  logger.log('  [builtin] React module pattern not found. Injecting runtime React unification shim.');
  // Anchor on the CJS wrapper's own opening brace — the same literal
  // extraction itself anchors on (bin/extract-from-binary.mjs), so it's
  // present in the RAW bundle before any patch runs, independent of phase
  // order. Previously anchored on 'globalThis.__hm_require = __hm_require;',
  // a literal esm_compat injects — but esm_compat is phase 'post' while this
  // patch is phase 'pre' (dependsOn can't point forward across phases), so
  // that anchor could be missing when this patch ran, silently no-oping the
  // fallback (found live 2026-08-21 building v2.1.238, where all 3 static
  // regex patterns above ALSO stopped matching for the first time, finally
  // exercising this fallback path and exposing the ordering gap).
  //
  // Correctness of injecting here despite running before esm_compat: when
  // esm_compat DOES apply later (every profile shipping react_singleton also
  // ships esm_compat — see ccpatch.yml's bare/minimal lists), it rewrites the
  // bundle as `esmHeader (with a top-level `await import('react')` that sets
  // globalThis.__hm_react) + <original CJS wrapper, unmodified except its
  // trailing invocation args> `. The wrapper is a function EXPRESSION —
  // whatever we inject inside its body only runs once the wrapper is
  // INVOKED, which is the last statement in the file, after esmHeader's
  // await has already resolved. So __hm_react is guaranteed set by the time
  // this shim's IIFE actually executes, regardless of textual injection
  // order. (If esm_compat is absent from the profile, this guard makes the
  // shim a no-op — same as the old anchor missing entirely; not a regression.)
  const CJS_WRAPPER_OPEN = '(function(exports, require, module, __filename, __dirname) {';
  const wrapperIdx = code.indexOf(CJS_WRAPPER_OPEN);
  if (wrapperIdx === -1) return code;

  const insertPoint = wrapperIdx + CJS_WRAPPER_OPEN.length;
  return code.slice(0, insertPoint) + '\n' + REACT_UNIFY_SHIM + code.slice(insertPoint);
}


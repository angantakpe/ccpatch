import { ccpLog } from '../cli/style.mjs';

const REACT_MOD_RE_V1 = /var \w+=d\(\((\w+)\)=>\{var \w+=Symbol\.for\("react\.(?:transitional\.)?element"\)/;
const REACT_MOD_RE_V2 = /(\w+)=p\(\((\w+),\w+\)=>\{[^}]*Symbol\.for\("react\.(?:transitional\.)?element"\)/;
const REACT_MOD_RE_V3 = /var [\w$]+=\w+\(\(([\w$]+)\)=>\{var [\w$]+=Symbol\.for\("react\.(?:transitional\.)?element"\)/;

const REACT_UNIFY_SHIM = `
// React singleton enforcement - runtime fallback
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
  const reactModMatchV1 = code.match(REACT_MOD_RE_V1);
  if (reactModMatchV1) {
    const [fullMatch, exportsVar] = reactModMatchV1;
    const patchedMatch = fullMatch.replace('=>{', `=>{Object.assign(${exportsVar},globalThis.__hm_react);`);
    ccpLog(`  [builtin] Bundled React module shimmed (pattern 1). (exports: ${exportsVar})`);
    return code.replace(fullMatch, patchedMatch);
  }

  const reactModMatchV2 = code.match(REACT_MOD_RE_V2);
  if (reactModMatchV2) {
    const [fullMatch, moduleVar, exportsVar] = reactModMatchV2;
    const patchedMatch = fullMatch.replace('=>{', `=>{Object.assign(${exportsVar},globalThis.__hm_react);`);
    ccpLog(`  [builtin] Bundled React module shimmed (pattern 2). (module: ${moduleVar}, exports: ${exportsVar})`);
    return code.replace(fullMatch, patchedMatch);
  }

  const reactModMatchV3 = code.match(REACT_MOD_RE_V3);
  if (reactModMatchV3) {
    const [fullMatch, exportsVar] = reactModMatchV3;
    const patchedMatch = fullMatch.replace('=>{', `=>{Object.assign(${exportsVar},globalThis.__hm_react);`);
    ccpLog(`  [builtin] Bundled React module shimmed (pattern 3). (exports: ${exportsVar})`);
    return code.replace(fullMatch, patchedMatch);
  }

  logger.log('  [builtin] React module pattern not found. Injecting runtime React unification shim.');
  const preloadEnd = code.indexOf('globalThis.__hm_require = __hm_require;');
  if (preloadEnd === -1) return code;

  const insertPoint = code.indexOf('\n', preloadEnd) + 1;
  return code.slice(0, insertPoint) + REACT_UNIFY_SHIM + code.slice(insertPoint);
}


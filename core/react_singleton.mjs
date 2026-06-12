import { applyReactSingletonShim } from '../runner/shims/react-singleton.mjs';

export default {
  name: 'react_singleton',
  version: '1.0.0',
  category: 'infrastructure',
  description: 'React singleton enforcement — unify the bundled React module with the host node_modules React',
  capabilities: [],
  phase: 'pre',
  required: true,
  // The shim has 3 regex fallback paths plus a runtime-injection branch.
  // Every successful branch emits the __ccpReactSingleton_v1 sentinel exactly
  // once (and references `globalThis.__hm_react`). The count anchors on the
  // sentinel because `globalThis.__hm_react` also appears in esm_compat's
  // header, so a count on it can never hold across composed profiles.
  verify: { present: '__ccpReactSingleton_v1', count: { present: 1 } },
  apply: (code, _opts) => applyReactSingletonShim(code),
};

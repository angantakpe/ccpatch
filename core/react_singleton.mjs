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
  // Every successful branch writes `globalThis.__hm_react` into the output.
  verify: { present: 'globalThis.__hm_react', count: { present: 1 } },
  apply: (code, _opts) => applyReactSingletonShim(code),
};

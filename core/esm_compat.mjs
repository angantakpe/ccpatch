import { applyEsmCompatibilityShim } from '../runner/shims/esm-compat.mjs';

export default {
  name: 'esm_compat',
  version: '1.0.0',
  category: 'infrastructure',
  description: 'ESM compatibility — wrap the CJS-IIFE bundle for ESM execution, pre-load react+ink',
  capabilities: [],
  phase: 'post',
  required: true,
  // Both branches (CJS-IIFE rewrite and native-ESM shim) emit `globalThis.__hm_ink`.
  verify: { present: 'globalThis.__hm_ink', count: { present: 2 } },
  apply: (code, _opts) => applyEsmCompatibilityShim(code),
};

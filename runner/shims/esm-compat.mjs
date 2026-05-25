const CJS_TAIL = '})(module.exports, require, module, __filename, __dirname);';
const CJS_HEAD = '(function(exports, require, module, __filename, __dirname)';

export function applyEsmCompatibilityShim(code, logger = console) {
  const cjsTailIdx = code.lastIndexOf(CJS_TAIL);
  const isCjsIife = code.includes(CJS_HEAD) && cjsTailIdx !== -1;

  if (isCjsIife) {
    const esmHeader = [
      `import { createRequire as __hm_createRequire } from 'node:module';`,
      `import { fileURLToPath as __hm_fileURLToPath } from 'node:url';`,
      `import { dirname as __hm_dirnameFn } from 'node:path';`,
      `const __hm_nativeRequire = __hm_createRequire(import.meta.url);`,
      `const __hm_filename = import.meta.filename ?? __hm_fileURLToPath(import.meta.url);`,
      `const __hm_dirname  = __hm_dirnameFn(__hm_filename);`,
      `const __hm_module   = { exports: {} };`,
      ``,
      `// Pre-load ESM modules that have top-level await (ink v5+)`,
      `const [__hmRI, __hmII] = await Promise.all([import('react'), import('ink')]);`,
      `globalThis.__hm_react = __hmRI.default || __hmRI;`,
      `globalThis.__hm_ink   = __hmII;`,
      ``,
      `// Shim require to handle pre-loaded ESM modules`,
      `const __hm_require = (id) => {`,
      `  if (id === 'react') return globalThis.__hm_react;`,
      `  if (id === 'ink') return globalThis.__hm_ink;`,
      `  return __hm_nativeRequire(id);`,
      `};`,
      `__hm_require.resolve = __hm_nativeRequire.resolve;`,
      `__hm_require.main = __hm_nativeRequire.main;`,
      `__hm_require.extensions = __hm_nativeRequire.extensions;`,
      `__hm_require.cache = __hm_nativeRequire.cache;`,
      `globalThis.__hm_require = __hm_require;`,
      ``,
    ].join('\n');
    const esmTail = '})(__hm_module.exports, __hm_require, __hm_module, __hm_filename, __hm_dirname);';
    const shebangEnd = code.indexOf('\n') + 1;
    logger.log('  [shim] ESM compatibility shim applied.');
    return code.slice(0, shebangEnd) + esmHeader + code.slice(shebangEnd, cjsTailIdx) + esmTail + code.slice(cjsTailIdx + CJS_TAIL.length);
  }

  // Avoid top-level await here. Some bundles include CommonJS markers, and
  // adding TLA can trigger Node's ambiguous module-format error.
  const esmNativeShim = `{try{const __hmReq=typeof __hm_nativeRequire==='function'?__hm_nativeRequire:(typeof require==='function'?require:null);if(__hmReq){const __hmRI=__hmReq('react');const __hmII=__hmReq('ink');globalThis.__hm_react=(__hmRI&&__hmRI.default)||__hmRI;globalThis.__hm_ink=__hmII;}}catch{}}\n`;
  const shebangEnd = code.indexOf('\n') + 1;
  logger.log('  [shim] Native-ESM bundle - injected require-based react+ink pre-load shim (no top-level await).');
  return code.slice(0, shebangEnd) + esmNativeShim + code.slice(shebangEnd);
}

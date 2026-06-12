import { ccpLog } from '../cli/style.mjs';

const CJS_TAIL = '})(module.exports, require, module, __filename, __dirname);';
const CJS_HEAD = '(function(exports, require, module, __filename, __dirname)';

// Where the prepended ESM header is safe to splice in: after a leading shebang
// line if one exists, otherwise at byte 0. npm-packaged cli.js bundles begin
// with `#!/usr/bin/env node`; bundles extracted from the Bun binary do NOT —
// their first line is the CJS IIFE opener (CJS_HEAD). Assuming line 1 is always
// a shebang injects `import` statements *inside* the IIFE body, which is illegal
// at module scope and crashes the patched bundle with "Unexpected token '{'".
function headerInsertOffset(code) {
  if (!code.startsWith('#!')) return 0;
  const nl = code.indexOf('\n');
  return nl === -1 ? code.length : nl + 1;
}

export function applyEsmCompatibilityShim(code) {
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
      `// Bun-SEA embedded-module awareness. The SEA carries a small VFS (cli.js`,
      `// plus native .node addons + their JS wrappers) that the extractor writes`,
      `// to ./embedded-manifest.json + ./embedded/ next to this bundle. We lazily`,
      `// load that manifest so a require() that misses can (a) be redirected to the`,
      `// extracted copy and (b) fail LOUD with an actionable message instead of a`,
      `// bare "Cannot find module". The whole logging path is fail-open: it never`,
      `// throws on its own, and on a genuine miss the ORIGINAL error (same type and`,
      `// .code) is re-thrown unchanged so upstream catch blocks behave identically.`,
      `let __hm_embeddedSet = null;`,
      `const __hm_loadEmbeddedManifest = () => {`,
      `  if (__hm_embeddedSet !== null) return __hm_embeddedSet;`,
      `  __hm_embeddedSet = new Map();`,
      `  try {`,
      `    const __p = __hm_nativeRequire('node:path');`,
      `    const __fs = __hm_nativeRequire('node:fs');`,
      `    const __mp = __p.join(__hm_dirname, 'embedded-manifest.json');`,
      `    if (__fs.existsSync(__mp)) {`,
      `      const __arr = JSON.parse(__fs.readFileSync(__mp, 'utf8'));`,
      `      for (const __e of (Array.isArray(__arr) ? __arr : [])) {`,
      `        if (__e && __e.path) {`,
      `          __hm_embeddedSet.set(__e.path, __e.path);`,
      `          __hm_embeddedSet.set(__p.basename(__e.path), __e.path);`,
      `        }`,
      `      }`,
      `    }`,
      `  } catch {}`,
      `  return __hm_embeddedSet;`,
      `};`,
      `// Map a require id to its embedded-VFS path, if any. Handles both bare`,
      `// (\"audio-capture.node\") and Bun-absolute (\"/$bunfs/root/audio-capture.node\")`,
      `// forms by also matching on basename.`,
      `const __hm_embeddedPathFor = (id) => {`,
      `  try {`,
      `    const set = __hm_loadEmbeddedManifest();`,
      `    if (set.has(id)) return set.get(id);`,
      `    const base = String(id).replace(/^.*[\\\\/]/, '');`,
      `    if (set.has(base)) return set.get(base);`,
      `  } catch {}`,
      `  return null;`,
      `};`,
      `// Shim require to handle pre-loaded ESM modules + embedded SEA modules`,
      `const __hm_require = (id) => {`,
      `  if (id === 'react') return globalThis.__hm_react;`,
      `  if (id === 'ink') return globalThis.__hm_ink;`,
      `  try {`,
      `    return __hm_nativeRequire(id);`,
      `  } catch (err) {`,
      `    if (err && err.code === 'MODULE_NOT_FOUND') {`,
      `      const embPath = __hm_embeddedPathFor(id);`,
      `      if (embPath) {`,
      `        // The Bun SEA embedded this module. Try the extracted copy next to`,
      `        // the bundle before giving up.`,
      `        try {`,
      `          const __p = __hm_nativeRequire('node:path');`,
      `          const __fs = __hm_nativeRequire('node:fs');`,
      `          const local = __p.join(__hm_dirname, 'embedded', embPath);`,
      `          if (__fs.existsSync(local)) return __hm_nativeRequire(local);`,
      `        } catch {}`,
      `        // Extraction did not materialize it — augment the message (keeping`,
      `        // err type + .code intact) so the failure is actionable.`,
      `        try {`,
      `          err.message = "module '" + id + "' is embedded in the Bun SEA but was not extracted — re-run extraction (make extract-from-binary). Original: " + err.message;`,
      `        } catch {}`,
      `      }`,
      `    }`,
      `    throw err;`,
      `  }`,
      `};`,
      `__hm_require.resolve = __hm_nativeRequire.resolve;`,
      `__hm_require.main = __hm_nativeRequire.main;`,
      `__hm_require.extensions = __hm_nativeRequire.extensions;`,
      `__hm_require.cache = __hm_nativeRequire.cache;`,
      `globalThis.__hm_require = __hm_require;`,
      ``,
    ].join('\n');
    const esmTail = '})(__hm_module.exports, __hm_require, __hm_module, __hm_filename, __hm_dirname);';
    const shebangEnd = headerInsertOffset(code);
    ccpLog('  [shim] ESM compatibility shim applied.');
    return code.slice(0, shebangEnd) + esmHeader + code.slice(shebangEnd, cjsTailIdx) + esmTail + code.slice(cjsTailIdx + CJS_TAIL.length);
  }

  // Avoid top-level await here. Some bundles include CommonJS markers, and
  // adding TLA can trigger Node's ambiguous module-format error.
  const esmNativeShim = `{try{const __hmReq=typeof __hm_nativeRequire==='function'?__hm_nativeRequire:(typeof require==='function'?require:null);if(__hmReq){const __hmRI=__hmReq('react');const __hmII=__hmReq('ink');globalThis.__hm_react=(__hmRI&&__hmRI.default)||__hmRI;globalThis.__hm_ink=__hmII;}}catch{}}\n`;
  const shebangEnd = headerInsertOffset(code);
  ccpLog('  [shim] Native-ESM bundle - injected require-based react+ink pre-load shim (no top-level await).');
  return code.slice(0, shebangEnd) + esmNativeShim + code.slice(shebangEnd);
}

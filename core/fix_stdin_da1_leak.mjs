/**
 * fix_stdin_da1_leak — Strip terminal Device Attributes (DA1) responses from
 * stdin before Ink's key handler reads them.
 *
 * Root cause:
 *   Something in the CLI bundle (typically a terminal capability detection
 *   library) sends `\033[c` (Primary Device Attributes request) to stdout.
 *   The terminal responds via stdin with `\033[?61;4;6;7;14;21;22;23;24;28;c`
 *   (or similar). Ink's key parser splits this:
 *     - `\033` → Escape key → clears the input field
 *     - `61;4;6;7;14;21;22;23;24;28;` → text → appears in the now-empty input
 *
 * Fix:
 *   Wrap process.stdin's data pipeline with a transform that strips CSI
 *   private sequences used only as terminal responses:
 *     - `\033[?...c`  Primary Device Attributes response (DA1)
 *     - `\033[>...c`  Secondary Device Attributes response (DA2)
 *   These sequences are never valid user keystrokes and safe to discard.
 */

const block = `var __ccpFixStdinDA1Installed=true;(function(){try{var __ccpDA1Re=/\\x1b\\[[?>][0-9;]*c/g;var __ccpStdinEmit=process.stdin.emit.bind(process.stdin);process.stdin.emit=function(event,data){if(event==='data'&&data!=null){var str=Buffer.isBuffer(data)?data.toString('binary'):(typeof data==='string'?data:null);if(str&&__ccpDA1Re.test(str)){__ccpDA1Re.lastIndex=0;var filtered=str.replace(__ccpDA1Re,'');if(!filtered)return false;data=Buffer.isBuffer(data)?Buffer.from(filtered,'binary'):filtered;}__ccpDA1Re.lastIndex=0;}return __ccpStdinEmit(event,data);};}catch(e){}})();`;

export default {
  name: 'fix_stdin_da1_leak',
  category: 'fix',
  description: 'Strip terminal DA1/DA2 responses from stdin to prevent escape-key + garbage-text split in Ink input.',
  capabilities: [],
  verify: { present: '__ccpFixStdinDA1Installed', weak: true },
  preload: true,
  preloadCode: block,
  apply: (code) => {
    if (code.includes('__ccpFixStdinDA1Installed')) return code;

    // Try shebang first (older Bun-extracted bundles).
    // Use includes() — earlier patches (e.g. fetch_interceptor) may have prepended
    // code, so startsWith() would miss the shebang if it's no longer at position 0.
    const SHEBANG = '#!/usr/bin/env node';
    if (code.includes(SHEBANG)) {
      const shebangIdx = code.indexOf(SHEBANG);
      const afterShebang = code.indexOf('\n', shebangIdx) + 1;
      console.log('  [fix_stdin_da1_leak] stdin DA1 filter installed (shebang anchor)');
      return code.slice(0, afterShebang) + block + '\n' + code.slice(afterShebang);
    }

    // CJS wrapper used by npm-distributed bundles (v2.1.138+).
    // Pattern: (function(exports,require,module,__filename,__dirname){  (spaces vary)
    // No ^ anchor — fetch_interceptor may have prepended code before the IIFE.
    const cjsAnchor = /\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*\{/;
    const m = code.match(cjsAnchor);
    if (m) {
      const insertAt = m.index + m[0].length;
      console.log('  [fix_stdin_da1_leak] stdin DA1 filter installed (CJS wrapper anchor)');
      return code.slice(0, insertAt) + block + code.slice(insertAt);
    }

    console.warn('  [!] fix_stdin_da1_leak: no injection anchor found — stdin DA1 filter not installed');
    return code;
  },
};

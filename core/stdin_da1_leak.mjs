/**
 * stdin_da1_leak — Strip terminal Device Attributes (DA1) responses from
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
  name: 'stdin_da1_leak',
  category: 'fix',
  description: 'Strip terminal DA1/DA2 responses from stdin to prevent escape-key + garbage-text split in Ink input.',
  capabilities: [],
  verify: { present: '__ccpFixStdinDA1Installed', count: { present: 1 } },
  preload: true,
  preloadCode: block,
  // Boot hook spliced by the runner's boot registry (runner/boot-registry.mjs).
  // The filter only wraps process.stdin.emit, so any pre-body slot works;
  // order 60 keeps it after the fetch/Bun infrastructure hooks. The old
  // sentinel guard (`if (code.includes('__ccpFixStdinDA1Installed'))`) is now
  // the registry's job — it skips patches whose sentinel is already present.
  bootInject: { order: 60, code: block },
};

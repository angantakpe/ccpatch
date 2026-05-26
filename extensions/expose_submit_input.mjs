/**
 * expose_submit_input — Expose React's user-input submit handler.
 *
 * Captures the live submit useCallback into globalThis.__ccpSubmitInput so
 * heartbeats can inject synthetic user prompts through the same path as
 * real user input.
 *
 * ── Anchor history ───────────────────────────────────────────────────────────
 * v2.1.141: let fT8=q8.useCallback(async(j$)=>{await rZ8(
 * v2.1.142: let o08=e$.useCallback(async(j$)=>{await CZ8(
 * v2.1.146: let b1=J8.useCallback(async(k$)=>{await qV8(
 *
 * All minified names rotate per version. We match the structural shape
 * `let <var>=<React>.useCallback(async(<arg>)=>{await <inner>(` and require the
 * inner call to start an object literal whose first field is `helpers:` — the
 * submit handler's signature dispatcher distinguishes it from other useCallbacks.
 */

export default {
  category: 'expose',

  description: 'Expose React submit useCallback via globalThis.__ccpSubmitInput.',
  capabilities: ["prompt"],
  verify: {
    present: '__ccpSubmitInputCaptured_v1',
    // Sentinel is injected exactly once (var __ccpSubmitInputCaptured_v1=!0;).
    count: { present: 1 },
  },
  dependsOn: ['expose_agent_tool'],
  apply: (code) => {
    if (code.includes('__ccpSubmitInputCaptured_v1')) return code;

    // Regex match the submit shape. The `{helpers:{` follow-on is what
    // disambiguates from other useCallback(async ...) sites.
    const re = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.useCallback\(async\(([A-Za-z_$][\w$]*)\)=>\{await ([A-Za-z_$][\w$]*)\(\{helpers:\{/;
    const m = code.match(re);
    if (!m) {
      console.warn('  [!] expose_submit_input: submit anchor not found — programmatic submit disabled');
      return code;
    }
    const [, varName, ReactNs, , innerFn] = m;
    const ucPrefix = `${ReactNs}.useCallback(`;
    // Strip the trailing `{helpers:{` (it's not consumed by the wrap; only
    // `let X=...await Y(` is rewritten so the original body continues unchanged).
    const anchor = `let ${varName}=${ReactNs}.useCallback(async(${m[3]})=>{await ${innerFn}(`;
    // The captured React useCallback expects a single arg of shape
    //   [{ value, preExpansionValue, mode: 'prompt', pastedContents, skipSlashCommands, uuid }]
    // (the "queuedCommands" array). External callers like headless_bridge pass
    // a plain string for ergonomics, so we install an adapter that wraps a
    // string into the expected array shape before delegating.
    const replacement =
      'var __ccpSubmitInputCaptured_v1=!0;' +
      `let ${varName}=(function(__ccpCb){try{` +
        `var __ccpSubmitInputAdapter=function(__inp,__opts){` +
          `var __qc;` +
          `if(typeof __inp==="string"){` +
            `__qc=[{value:__inp,preExpansionValue:__inp,mode:"prompt",` +
              `pastedContents:void 0,skipSlashCommands:false,` +
              `uuid:(globalThis.crypto&&globalThis.crypto.randomUUID)?globalThis.crypto.randomUUID():String(Math.random()).slice(2)}];` +
          `}else if(Array.isArray(__inp)){__qc=__inp;}else{__qc=[__inp];}` +
          `return __ccpCb(__qc);` +
        `};` +
        `globalThis.__ccpSubmitInput=__ccpSubmitInputAdapter;` +
        `if(typeof globalThis.__ccpProvide==="function"){` +
          `globalThis.__ccpProvide("submitInput",{version:1,producer:"expose_submit_input",shape:[],value:__ccpSubmitInputAdapter});` +
        `}` +
      `}catch(_ccpSI_){}return __ccpCb;})(${anchor.slice(anchor.indexOf('=') + 1)}`;

    code = code.replace(anchor, replacement);

    // Find the matching close of the useCallback by paren-counting.
    const ucStart = code.indexOf(ucPrefix, code.indexOf('__ccpSubmitInputCaptured_v1=!0;'));
    if (ucStart < 0) {
      console.warn('  [!] expose_submit_input: useCallback start not found — bailing');
      return code;
    }
    const startIdx = ucStart + ucPrefix.length;
    let depth = 1;
    let endIdx = -1;
    for (let i = startIdx; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }
    if (endIdx < 0) {
      console.warn('  [!] expose_submit_input: useCallback close not found — bailing');
      return code;
    }

    code = code.slice(0, endIdx) + ')' + code.slice(endIdx);
    return code;
  },
};

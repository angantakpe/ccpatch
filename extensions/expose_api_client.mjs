/**
 * expose_api_client — Expose the Anthropic SDK client instance on globalThis.
 *
 * Stashes the resolved client at `globalThis.__ccpApiClient` and exposes the
 * factory at `globalThis.__ccpMakeApiClient` so ccpatch can call the
 * Anthropic API directly (shadow-agent runner) without spawning a subprocess.
 *
 * ── How Tu() ends (v2.1.142) ─────────────────────────────────────────────
 *   async function Tu({apiKey:H,maxRetries:$,model:q,fetchOverride:K,source:_}){
 *     // ... auth, routing, bedrock, vertex, foundry, gateway ...
 *     let P={apiKey:qq()?null:L,authToken:qq()?xq()?.accessToken:void 0,...X,...UN()&&{logger:hYH()}};
 *     return new zh(P)          ← only instance of `return new zh(P)` in the bundle
 *   }
 *
 * ── Anchor ────────────────────────────────────────────────────────────────
 * Anchor: `return new zh(P)}async function WV1(`
 * Verified cardinality: exactly 1 match in cli.v2.1.142.cjs.
 * The anchor combines the unique final return of Tu() with the immediately
 * following function declaration — doubly unique, unlikely to rotate.
 *
 * ── Anchor history ────────────────────────────────────────────────────────
 * v2.1.142: return new zh(P)}async function WV1(
 * v2.1.146: return new ch(Z)}async function IC1(   (Tu→jm, zh→ch, P→Z, WV1→IC1)
 *
 * Names rotate every release, so we capture them with a regex over the
 * stable shape: `return new <CLIENT>(<OPTSVAR>)}async function <NEXT>(`.
 * The opts var is the local built from Tu()/jm()'s parameter spread, so it
 * disambiguates from the earlier `return new <CLIENT>({apiKey:...})` inside
 * the same function body.
 */

export default {
  category: 'expose',

  description: 'Expose Anthropic SDK client via globalThis.__ccpApiClient and __ccpMakeApiClient.',
  capabilities: ["network"],
  verify: {
    present: '__ccpApiClientExposed_v1',
    // Sentinel is injected exactly once.
    count: { present: 1 },
  },
  allowOverlapWith: ['force_thinking'],
  apply: (code) => {
    if (code.includes('__ccpApiClientExposed_v1')) return code;

    // Discover the (clientCtor, optsVar, nextFn, factoryFn) names via regex.
    // Match the *last* `return new X(VAR)}async function Y(` in the bundle that
    // sits immediately at a function boundary — by construction, that's the end
    // of the SDK client factory.
    const re = /return new ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\}async function ([A-Za-z_$][\w$]*)\(/g;
    let factoryRe = /async function ([A-Za-z_$][\w$]*)\(\{apiKey:[A-Za-z_$][\w$]*,maxRetries:[A-Za-z_$][\w$]*,model:[A-Za-z_$][\w$]*,fetchOverride:[A-Za-z_$][\w$]*,source:[A-Za-z_$][\w$]*\}\)/;
    const factoryMatch = code.match(factoryRe);
    if (!factoryMatch) {
      console.warn('  [!] expose_api_client: SDK factory function not found — API client not exposed');
      return code;
    }
    // The matching `return new X(VAR)}async function Y(` must follow the
    // factory and be the unique closer; pick the first one after the factory start.
    re.lastIndex = factoryMatch.index;
    const m = re.exec(code);
    if (!m) {
      console.warn('  [!] expose_api_client: anchor not found — API client not exposed');
      return code;
    }
    const [matchedAnchor, CLIENT, OPTSVAR, NEXT] = m;
    const FACTORY = factoryMatch[1];
    const ANCHOR = matchedAnchor;

    // Replace the closing `return new zh(P)` with a capture + stash, then return.
    // Wrapped in try/catch so a stash failure never kills the CLI boot.
    //
    // Also wraps messages.stream on the single shared instance so both the
    // interactive CLI and the shadow-agent runner go through the same reference.
    // This lets us track active stream count (globalThis.__ccpActiveStreams) and
    // gate heartbeat calls when an interactive stream is live — preventing the
    // 429 rate-limit contention caused by concurrent requests on the same OAuth token.
    //
    // Callers tag themselves via the options object: { __ccpCaller: 'heartbeat' | 'interactive' }.
    // Untagged calls are treated as interactive (safe default — never blocked).
    const replacement =
      'var __ccpApiClientExposed_v1=!0;' +
      `const __ccpInst=new ${CLIENT}(${OPTSVAR});` +
      'try{' +
        'globalThis.__ccpApiClient=__ccpInst;' +
        `globalThis.__ccpMakeApiClient=${FACTORY};` +
        // ── Contract registration ────────────────────────────────────────
        // Consumers can call __ccpRequire('apiClient', { consumer, minVersion: 1,
        // shape: ['messages.stream','beta.messages.stream'] }) and get an
        // actionable error when the SDK rotates its sub-API layout.
        'if(typeof globalThis.__ccpProvide==="function"){' +
          'try{globalThis.__ccpProvide("apiClient",{' +
            'version:1,producer:"expose_api_client",' +
            'shape:["messages.stream","beta.messages.stream"],' +
            'value:__ccpInst' +
          '});' +
          'globalThis.__ccpProvide("makeApiClient",{' +
            'version:1,producer:"expose_api_client",shape:[],' +
            `value:${FACTORY}` +
          '});}catch(_ccpAC_prov_){}' +
        '}' +
        'globalThis.__ccpActiveStreams=globalThis.__ccpActiveStreams||{interactive:0,heartbeat:0};' +
        // Generic wrap helper — patches a single .stream method on a sub-API once.
        // The interactive TUI uses client.beta.messages.stream, the shadow-agent
        // uses client.messages.stream. We wrap BOTH so the counter reflects real activity.
        'const __ccpWrapStream=function(subApi,label){' +
          'if(!subApi||subApi.__ccpStreamWrapped)return;' +
          'const __ccpOrigStream=subApi.stream.bind(subApi);' +
          'subApi.stream=function __ccpStreamGated(params,reqOpts){' +
            'const caller=(reqOpts&&reqOpts.__ccpCaller)||"interactive";' +
            // Strip internal key before forwarding — SDK doesn't know about it.
            'const fwdOpts=reqOpts?Object.assign({},reqOpts):void 0;' +
            'if(fwdOpts)delete fwdOpts.__ccpCaller;' +
            'const bucket=globalThis.__ccpActiveStreams;' +
            'bucket[caller]=(bucket[caller]||0)+1;' +
            'const s=__ccpOrigStream(params,fwdOpts);' +
            // Decrement on finish (both success and error paths).
            's.finalMessage().then(function(){bucket[caller]=Math.max(0,(bucket[caller]||1)-1);},function(){bucket[caller]=Math.max(0,(bucket[caller]||1)-1);});' +
            'return s;' +
          '};' +
          'subApi.__ccpStreamWrapped=label||!0;' +
        '};' +
        '__ccpWrapStream(__ccpInst.messages,"messages");' +
        '__ccpWrapStream(__ccpInst.beta&&__ccpInst.beta.messages,"beta.messages");' +
        'process.stderr.write("[expose_api_client] ccpatch API client exposed (wrapped: messages, beta.messages)\\n");' +
      '}catch(__ccpAC_err){try{process.stderr.write("[expose_api_client] wrap failed: "+(__ccpAC_err&&__ccpAC_err.message)+"\\n");}catch(_){}}' +
      `return __ccpInst;}async function ${NEXT}(`;

    return code.replace(ANCHOR, replacement);
  },
};

/**
 * expose_tool_dispatch — Expose MCP tool registry and invoker on globalThis.
 *
 * Stashes the live tool state from inside HI4() (the query generator) so the
 * shadow-agent runner can (a) pass a real `tools` array to the Anthropic API
 * and (b) dispatch tool_use blocks back through the same tool objects.
 *
 * Exposed globals
 * ───────────────
 * globalThis.__ccpGetTools()
 *   Returns the API-formatted tool array last seen for a real query. Returns []
 *   if never called or stash is absent.
 *
 * globalThis.__ccpBuildToolContext()
 *   Returns a fresh synthetic toolUseContext built from the most recently
 *   stashed context + a fresh AbortController. Use instead of __ccpToolUseCtx
 *   for per-invocation isolation (avoids stale abort signals, per-request
 *   state bleeding across heartbeat calls).
 *
 * globalThis.__ccpMcpHealth()
 *   Returns { tool_count, mcp_tool_count, connected_servers, total_servers, last_error }
 *   by inspecting stashed raw tools for isMcp flags and live mcpClients.
 *   Useful as a health probe before attempting MCP tool dispatch.
 *
 * globalThis.__ccpInvokeTool(name, input, signal?)
 *   Dispatches a tool call through the live tool object. Calls
 *   __ccpBuildToolContext() internally for per-invocation context isolation.
 *   Returns: Promise<{ content: Array<{type,text}>, isError?: boolean }>
 *   On any error: rejects with an Error whose message describes the failure.
 *
 * ── Anchor strategy (multi-anchor fallback chain) ─────────────────────────
 *
 * ANCHOR 1 (primary) — structural five-arg pattern in Promise.all/map/formatter:
 *   getToolPermissionContext + agents + allowedAgentTypes + model + deferLoading
 *   co-located inside a Promise.all(...map(...)));if( pattern.
 *   Cardinality in v2.1.142 source: 1. Stable because these five named args
 *   appear together only in the tool-format pipeline.
 *
 * ANCHOR 2 (fallback) — tengu-off-switch proximity:
 *   "tengu-off-switch" is a unique string literal ~1276 chars before the
 *   injection site in v2.1.142. Scans forward from that landmark to locate
 *   the Promise.all tool-format call.
 *
 * ANCHOR 3 (last resort) — allowedAgentTypes + deferLoading co-location in
 *   the same Promise.all map without relying on exact minified names.
 *
 * If all anchors miss: console.warn and return code unchanged (safe skip).
 *
 * ── Preflight validation ───────────────────────────────────────────────────
 * Before injecting, confirms the resolved match contains "getToolPermissionContext"
 * and "await Promise.all". If validation fails, warns and skips — never injects
 * in a wrong location.
 *
 * ── Anchor history ────────────────────────────────────────────────────────
 * v2.1.142 source sha256: 76b7ee7aa5a2a5210f4dd6b3abcfb0a6f2593d2ffe985d57ddb834e5c38a69b5
 * v2.1.142 primary anchor offset: 12317404
 * v2.1.142 tengu-off-switch offset: 12316128 (delta: -1276 from injection)
 * See: extensions/.expose_tool_dispatch.anchors.json
 *
 * ── MCP caveat ────────────────────────────────────────────────────────────
 * __ccpBuildToolContext() builds a fresh context from the stashed base but with a
 * new AbortController, avoiding stale-signal issues across heartbeat calls.
 * MCP socket liveness is checked via __ccpMcpHealth() before dispatch — if no
 * MCP servers are reachable, the shadow runner skips MCP-only tools rather
 * than hanging.
 */

export default {
  category: 'expose',

  description: 'Expose MCP tool registry, health probe, context factory, and invoker via globalThis.',
  capabilities: ["tools"],
  verify: {
    present: '__ccpToolDispatchExposed_v2',
    // Sentinel is injected exactly once.
    count: { present: 1 },
  },
  apply: (code) => {
    if (code.includes('__ccpToolDispatchExposed_v2')) return code;

    // ── Anchor resolution (multi-anchor fallback chain) ───────────────────

    // ANCHOR 1: structural five-arg pattern inside Promise.all + map + formatter call.
    // Minified names rotate (e.g. v2.1.142: I,X,K,A,lM8,j; v2.1.148: V,X,N$,A,SJ8,W); the
    // five semantic arg names are stable. Identifiers must match the JS identifier
    // syntax — bundlers may emit `$` in names (e.g. `N$`), so use [\w$]+ not \w+.
    //
    // Captures (used by the injection to reference the right minified vars):
    //   $1 — output var (formatted tools array, left of `=await Promise.all`)
    //   $2 — input array iterated by .map (raw source list)
    //   $3 — per-tool lambda var (used for backref consistency)
    //   $4 — toolUseContext object (the `A` in `A.getToolPermissionContext`)
    //   $5 — raw tools list passed as the inner `tools:` value
    const A1_RE = /([\w$]+)=await Promise\.all\(([\w$]+)\.map\(\(([\w$]+)\)=>[\w$]+\(\3,\{getToolPermissionContext:([\w$]+)\.getToolPermissionContext,tools:([\w$]+),agents:\4\.agents,allowedAgentTypes:\4\.allowedAgentTypes,model:\4\.model,deferLoading:[\w$]+\(\3\)\}\)\)\);if\(/g;

    // ANCHOR 2: tengu-off-switch landmark + scan forward for the tool-format Promise.all.
    // Unique string ~1276 bytes before the injection site in v2.1.142.
    const A2_LANDMARK = 'tengu-off-switch';
    const A2_SCAN_RE = /([\w$]+)=await Promise\.all\(([\w$]+)\.map\(\(([\w$]+)\)=>[\w$]+\(\3,\{getToolPermissionContext:([\w$]+)\.getToolPermissionContext,tools:([\w$]+),agents:\4\.agents,allowedAgentTypes:\4\.allowedAgentTypes,model:\4\.model,deferLoading:[\w$]+\(\3\)\}\)\)\);if\(/;

    // ANCHOR 3: allowedAgentTypes + deferLoading co-location in the same Promise.all map.
    // More permissive — accepts any key ordering between the two stable names.
    // Captures: $1=output, $2=input array, $3=per-tool var, $4=ctx var, $5=raw tools list.
    const A3_RE = /([\w$]+)=await Promise\.all\(([\w$]+)\.map\(\(([\w$]+)\)=>[\w$]+\(\3,\{[^}]*?tools:([\w$]+),[^}]*?allowedAgentTypes:([\w$]+)\.allowedAgentTypes[^}]*deferLoading:[\w$]+\(\3\)\}\)\)\);if\(/g;

    let matchStr = null;
    let matchGroups = null;
    let anchorUsed = null;

    // Try anchor 1.
    {
      const all = [...code.matchAll(A1_RE)];
      if (all.length === 1) {
        matchStr = all[0][0];
        matchGroups = { outVar: all[0][1], ctxVar: all[0][4], rawToolsVar: all[0][5] };
        anchorUsed = 'anchor1-structural';
      } else if (all.length > 1) {
        console.warn(`  [!] expose_tool_dispatch: anchor1 matched ${all.length} times — ambiguous`);
      }
    }

    // Try anchor 2: tengu-off-switch proximity scan.
    if (!matchStr) {
      const landmarkIdx = code.indexOf(A2_LANDMARK);
      if (landmarkIdx !== -1) {
        // Scan up to 4000 chars forward from landmark.
        const region = code.slice(landmarkIdx, landmarkIdx + 4000);
        const m = region.match(A2_SCAN_RE);
        if (m) {
          // Verify it's unique in the full file before using it.
          const all = [...code.matchAll(new RegExp(A2_SCAN_RE.source, 'g'))];
          if (all.length === 1) {
            matchStr = m[0];
            matchGroups = { outVar: m[1], ctxVar: m[4], rawToolsVar: m[5] };
            anchorUsed = 'anchor2-tengu-proximity';
          } else {
            console.warn(`  [!] expose_tool_dispatch: anchor2 candidate matched ${all.length} times — skipping`);
          }
        }
      }
    }

    // Try anchor 3: allowedAgentTypes + deferLoading co-location.
    if (!matchStr) {
      const all = [...code.matchAll(A3_RE)];
      if (all.length === 1) {
        matchStr = all[0][0];
        // anchor3 puts ctxVar in capture 5 (allowedAgentTypes:<ctx>.allowedAgentTypes)
        matchGroups = { outVar: all[0][1], ctxVar: all[0][5], rawToolsVar: all[0][4] };
        anchorUsed = 'anchor3-arg-pair';
      } else if (all.length > 1) {
        console.warn(`  [!] expose_tool_dispatch: anchor3 matched ${all.length} times — ambiguous`);
      }
    }

    if (!matchStr) {
      console.warn('  [!] expose_tool_dispatch: all anchors failed — tool dispatch not exposed');
      return code;
    }

    // ── Preflight validation ──────────────────────────────────────────────
    if (!matchStr.includes('getToolPermissionContext') || !matchStr.includes('await Promise.all')) {
      console.warn('  [!] expose_tool_dispatch: preflight failed — matched text lacks expected shape, skipping');
      return code;
    }

    console.log(`  [expose_tool_dispatch] using ${anchorUsed}`);

    // ── Build replacement ─────────────────────────────────────────────────
    // The matched string ends with ");if(" — split there and inject between.
    const SUFFIX = ');if(';
    const splitAt = matchStr.lastIndexOf(SUFFIX);
    if (splitAt === -1) {
      console.warn('  [!] expose_tool_dispatch: cannot split at );if( — skipping');
      return code;
    }

    const anchorPrefix = matchStr.slice(0, splitAt + ');'.length); // up to and including );
    const anchorSuffix = matchStr.slice(splitAt + ');'.length);    // if(...

    const { outVar, ctxVar, rawToolsVar } = matchGroups;
    const injection =
      'try{' +
        'var __ccpToolDispatchExposed_v2=!0;' +
        // Stash formatted tools (API-ready array — minified output var from regex)
        `globalThis.__ccpFormattedTools=${outVar};` +
        // Stash raw tool objects (the `tools:` value passed to the formatter)
        `globalThis.__ccpRawTools=${rawToolsVar};` +
        // Stash live toolUseContext (captured by reference)
        `globalThis.__ccpToolUseCtx=${ctxVar};` +
        // Fresh context factory — new AbortController per invocation to avoid
        // stale abort signals from the prior request lifecycle.
        'globalThis.__ccpBuildToolContext=function(){' +
          'var base=globalThis.__ccpToolUseCtx;' +
          'if(!base)return null;' +
          'var ac=new AbortController();' +
          'return Object.assign(Object.create(null),base,{abortController:ac});' +
        '};' +
        // Health probe — inspects raw tools and mcpClients for connectivity state.
        'globalThis.__ccpMcpHealth=function(){' +
          'var tools=globalThis.__ccpRawTools||[];' +
          'var ctx=globalThis.__ccpToolUseCtx;' +
          'var mcpTools=tools.filter(function(t){return t&&t.isMcp===!0;});' +
          'var clients=ctx&&ctx.mcpClients;' +
          'var serverCount=clients&&typeof clients==="object"?Object.keys(clients).length:0;' +
          'var connectedCount=0;' +
          'var lastError=null;' +
          'if(clients){' +
            'Object.values(clients).forEach(function(c){' +
              'try{' +
                'var dead=c&&(c.closed===!0||c.destroyed===!0||(c.transport&&c.transport.closed===!0));' +
                'if(!dead)connectedCount++;' +
              '}catch(e){lastError=String(e);}' +
            '});' +
          '}else{connectedCount=serverCount;}' +
          'return{' +
            'tool_count:tools.length,' +
            'mcp_tool_count:mcpTools.length,' +
            'connected_servers:connectedCount,' +
            'total_servers:serverCount,' +
            'last_error:lastError' +
          '};' +
        '};' +
        // __ccpGetTools — returns API-formatted array for passing to the Anthropic SDK.
        'globalThis.__ccpGetTools=function(){' +
          'return globalThis.__ccpFormattedTools||[];' +
        '};' +
        // __ccpInvokeTool — dispatches through the live tool .call() method.
        // Uses __ccpBuildToolContext() for a fresh per-invocation context.
        'globalThis.__ccpInvokeTool=async function(name,input,signal){' +
          'var tools=globalThis.__ccpRawTools;' +
          'if(!tools)throw new Error("[ccpInvokeTool] tool registry not stashed yet");' +
          'var tool=null;' +
          'for(var i=0;i<tools.length;i++){if(tools[i]&&tools[i].name===name){tool=tools[i];break}}' +
          'if(!tool)throw new Error("[ccpInvokeTool] unknown tool: "+name);' +
          'var ctx=globalThis.__ccpBuildToolContext();' +
          'if(!ctx)throw new Error("[ccpInvokeTool] toolUseContext not stashed yet");' +
          'if(signal)ctx.abortController=Object.assign(Object.create(null),ctx.abortController,{signal:signal});' +
          'var toolUseId="ccp-"+Date.now()+"-"+Math.random().toString(36).slice(2);' +
          // Signature from bundle: async call(input, toolUseContext, toolUseId, extra, progressCb)
          'var result=await tool.call(input,ctx,toolUseId,void 0,void 0);' +
          'return result;' +
        '};' +
        // ── Contract registration ────────────────────────────────────────
        // Single "toolDispatch" contract exposes the four helpers as one
        // bundle so consumers can probe shape paths against the same object.
        'if(typeof globalThis.__ccpProvide==="function"){' +
          'try{globalThis.__ccpProvide("toolDispatch",{' +
            'version:2,producer:"expose_tool_dispatch",' +
            'shape:["getTools","invokeTool","buildToolContext","mcpHealth"],' +
            'value:{' +
              'getTools:globalThis.__ccpGetTools,' +
              'invokeTool:globalThis.__ccpInvokeTool,' +
              'buildToolContext:globalThis.__ccpBuildToolContext,' +
              'mcpHealth:globalThis.__ccpMcpHealth' +
            '}' +
          '});}catch(_ccpTD_prov_){}' +
        '}' +
        'console.log("[expose_tool_dispatch] ccpatch tool dispatch v2 exposed (__ccpGetTools/__ccpInvokeTool/__ccpBuildToolContext/__ccpMcpHealth)");' +
      '}catch(__ccpTD_err){' +
        'console.warn("[expose_tool_dispatch] stash failed:",String(__ccpTD_err));' +
      '}';

    const replacement = anchorPrefix + injection + anchorSuffix;
    return code.replace(matchStr, replacement);
  },
};

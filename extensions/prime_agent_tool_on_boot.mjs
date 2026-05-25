/**
 * prime_agent_tool_on_boot — Prime globalThis.__ccpAgentTool at React mount time.
 *
 * ── Problem ──────────────────────────────────────────────────────────────────
 * expose_agent_tool sets _primed=true only when the user submits their first
 * prompt (via the bm4/let m=Z() early-prime anchor). Heartbeat ticks that
 * fire before that first submit see _primed=false and fall back to the worker
 * registry, which has no CC subagent names → instant timed_out.
 *
 * ── Strategy ─────────────────────────────────────────────────────────────────
 * Strategy B (direct context construction at mount):
 *   - Find the empty-deps useEffect in the main REPL React component that fires
 *     on mount (the "pro-trial-expired" check).
 *   - Inject a NEW empty-deps useEffect immediately before it. On mount:
 *       1. Call vX([], [], new AbortController, null) — vX is the
 *          getToolUseContext factory (React useCallback) that returns a live
 *          context backed by MH.getState(). It reads mainLoopModel from state
 *          internally, so passing null is safe.
 *       2. Call globalThis.__ccpAgentTool._capture(ctx) to set _primed=true
 *          and _ctxTemplate on the same tick as React mount.
 *   - Strategy A (synthetic submit) was rejected: costs a wasted API call.
 *   - Boot-time prime (before React mounts) is infeasible — vX does not exist
 *     until the component function runs.
 *
 * ── Anchor ───────────────────────────────────────────────────────────────────
 * Anchor: `"/pro-trial-expired",{setCursorOffset:()=>{},clearBuffer:()=>{},resetHistory:()=>{}})},[]);`
 *   - Cardinality: exactly 1 in v2.1.140 (verified).
 *   - Stability: uses only string literals and empty-function shapes — no
 *     minified identifiers.
 *   - Location: end of the empty-deps mount useEffect that checks for expired
 *     Pro trial, inside the main REPL React component. vX is in scope here.
 *   - On miss: console.warn + return code unchanged — expose_agent_tool's
 *     original late-prime path remains. No regression.
 *
 * ── Prime ordering (after this patch) ───────────────────────────────────────
 *   BOOT:    AHH() called at bundle init → _callSelf set
 *   MOUNT:   React component mounts → injected useEffect → vX([],[],AC,null)
 *            → _capture(ctx) → _primed=true, _ctxTemplate=live ctx
 *   EARLY:   First user prompt → bm4 → let m=Z() → _capture(m) [no-op if
 *            already primed; refreshes _ctxTemplate with real messages]
 *   FALLBACK: First Task call → vC7.call() → _capture(M) [no-op if primed]
 *
 * ── Heartbeat readiness ──────────────────────────────────────────────────────
 * After this patch, agentTool._primed and agentTool._callSelf are both true
 * from React mount onward — well before the first user submit.
 * The heartbeat dispatcher check `if (!agentTool._primed || !agentTool._callSelf)`
 * passes from the first tick after mount.
 *
 * ── Context quality note ─────────────────────────────────────────────────────
 * The ctx returned by vX([], [], AC, null) at mount time has:
 *   - getAppState(): live → returns MH.getState() with real toolPermissionContext
 *   - options.agentDefinitions: live → real activeAgents list (trading-analyst etc.)
 *   - options.tools: live → kyH() from real tool registry
 *   - messages: [] (empty — no conversation yet, but invoke() always passes [])
 *   - abortController: the mount-time AC (discarded; invoke() replaces it)
 *   - mainLoopModel: null → inside vX, wq=null becomes options.mainLoopModel=null
 *     (invoke() uses tmpl.options?.mainLoopModel ?? XH anyway — safe)
 * This is sufficient for vC7.call() to resolve agentDefinitions and dispatch.
 */

export default {
  category: 'expose',

  description: 'Prime __ccpAgentTool._primed at React mount time (no user input required).',
  capabilities: ["tools"],
  dependsOn: ['expose_agent_tool'],
  verify: { present: '_ccpBootPrime_', label: 'Prime AgentTool on Boot' },

  apply: (code) => {
    // Idempotency guard.
    if (code.includes('_ccpBootPrime_')) return code;

    // ── MOUNT PRIME — inject useEffect([]) before the pro-trial-expired check ──
    // This useEffect fires once when the main REPL component mounts.
    // vX (getToolUseContext) is in scope here as a React useCallback.
    const mountAnchor = '"/pro-trial-expired",{setCursorOffset:()=>{},clearBuffer:()=>{},resetHistory:()=>{}})},[]);';

    if (!code.includes(mountAnchor)) {
      console.warn('  [!] prime_agent_tool_on_boot: mount anchor (pro-trial-expired useEffect) not found — _primed stays late (first user prompt). No regression.');
      return code;
    }

    // Resolve the React identifier dynamically from the nearest `.useEffect`
    // call before the anchor (minified idents rotate per version).
    const reactIdentMatch = code.slice(Math.max(0, code.indexOf(mountAnchor) - 500), code.indexOf(mountAnchor)).match(/([\w$]+)\.useEffect/);
    const reactIdent = reactIdentMatch ? reactIdentMatch[1] : null;
    if (!reactIdent) {
      console.warn('  [!] prime_agent_tool_on_boot: could not resolve React identifier near anchor — skipping mount injection.');
      return code;
    }

    // Mount-time prime + poll: capture once at mount (gets _primed=true with a
    // minimal ctx), then re-capture every 2s until mcpClients populates. Stop
    // polling after MCP tools appear or after 30 attempts (~60s).
    //
    // Uses __ccpRequire('agentTool', ...) to resolve the producer's contract.
    // If expose_agent_tool's bootstrap shipped a broken AgentTool (missing
    // _capture), this throws once at mount with the producer's identity in
    // the message instead of silently no-op'ing every 2s.
    const mountInjection = `try{(()=>{var _ccpBootPrime_=!0;})();}catch(_){}`
      + `${reactIdent}.useEffect(()=>{`
      + `var _ccpAgent;`
      + `try{`
      +   `_ccpAgent=globalThis.__ccpRequire`
      +     `?globalThis.__ccpRequire("agentTool",{consumer:"prime_agent_tool_on_boot",minVersion:1,shape:["_capture"]})`
      +     `:globalThis.__ccpAgentTool;`
      + `}catch(_ccpReq_){`
      +   `try{process.stderr.write("[prime_agent_tool_on_boot] "+(_ccpReq_&&_ccpReq_.message||_ccpReq_)+"\\n");}catch(_){}`
      +   `return;`
      + `}`
      + `if(!_ccpAgent)return;`
      + `var _ccpDoCapture=function(){`
      +   `try{`
      +     `var _ccpAC=new AbortController;`
      +     `var _ccpCtx=vX([],[],_ccpAC,null);`
      +     `if(_ccpCtx){`
      +       `_ccpAgent._capture(_ccpCtx);`
      +       `var _ccpMcp=(_ccpCtx.options?.mcpClients||[]).length;`
      +       `var _ccpTools=(_ccpCtx.options?.tools||[]).length;`
      +       `return{mcp:_ccpMcp,tools:_ccpTools};`
      +     `}`
      +   `}catch(_ccpE){}`
      +   `return null;`
      + `};`
      + `_ccpDoCapture();`
      + `var _ccpAttempts=0;`
      + `var _ccpIv=setInterval(function(){`
      +   `_ccpAttempts++;`
      +   `var _ccpR=_ccpDoCapture();`
      +   `var _ccpCur=(_ccpAgent._ctxTemplate?.options?.mcpClients||[]).length;`
      +   `if(_ccpCur>0||_ccpAttempts>=30){clearInterval(_ccpIv);}`
      + `},2000);`
      + `return ()=>{try{clearInterval(_ccpIv);}catch(_){}};`
      + `},[]);`;

    code = code.replace(mountAnchor, mountAnchor + mountInjection);

    return code;
  },
};

/**
 * expose_agent_tool — Expose the bundle's native AgentTool (vC7) for background invocation.
 *
 * ── Anchors used (v2.1.139, cardinality verified = 1 each) ──────────────────
 *
 * 1. BOOTSTRAP anchor — shebang (normalizer prepends before patches run):
 *      `#!/usr/bin/env node`
 *    Injects the __ccpAgentTool bootstrap object at module-top.
 *
 * 2. REGISTRATION anchor — tools registry function AHH() (bundle init):
 *      `function AHH(){return[vC7,`
 *    AHH() is the tools registry function that returns the full tool array.
 *    It is called during bundle initialization — before any user input.
 *    Injection prepends `_captureTool(vC7)` so `_callSelf` flips at bundle
 *    init with no human action required. Cardinality = 1 in v2.1.140 (verified).
 *
 *    Why AHH() / `function AHH(){return[vC7,`:
 *      - vC7 is fully constructed before AHH() is first invoked.
 *      - AHH() is called multiple times (tool list refresh); capture is idempotent.
 *      - The vC7 identifier appears directly in the return expression.
 *
 * 3. EARLY PRIME anchor — bm4() main-query context construction:
 *      `let m=Z();for(let F=0;F<C.length;F++){`
 *    `m` = `Z()` = toolUseContext for the first user-facing turn.
 *    (v2.1.139: `let m=Z();for(let F=0;F<R.length;F++){` — R→C, fu4→bm4)
 *    This fires on the FIRST user prompt submitted, BEFORE any Task/AgentTool call.
 *    Injection appends `globalThis.__ccpAgentTool?._capture?.(m)` inline so
 *    `_primed` flips to `true` on the first user message.
 *
 *    Why bm4() / `let m=Z()`:
 *      - bm4() is called synchronously from the React onSubmit handler on every turn.
 *      - Z() returns the canonical toolUseContext with all live accessors.
 *      - Cardinality = 1 in v2.1.140 (verified via grep on CJS source).
 *      - The `m` object has the identical shape that vC7.call() receives
 *        as its second parameter.
 *
 * 4. FALLBACK PRIME anchor — the AgentTool.call() method signature:
 *      `async call({prompt:H,subagent_type:$,...},M,w,D,j){`
 *    Identical in v2.1.140 — destructured property names are stable English
 *    identifiers; only the outer AgentTool identifier changed (ZR7→vC7).
 *    Retained as a fallback: if the bm4 anchor misses (version drift),
 *    the first real user-facing Task invocation primes the tool as before.
 *    Also captures _callSelf as defense-in-depth (no-op if already set by
 *    registration anchor #2). _capture() no-ops when already primed by anchor #3.
 *
 * ── Prime ordering ───────────────────────────────────────────────────────────
 *   1. BUNDLE INIT: AHH() called → _captureTool(vC7) → sets _callSelf
 *                  Fires during bundle initialization, before any user input.
 *   2. EARLY:    first user prompt → bm4 → let m=Z() → _capture(m)
 *                sets _primed=true, _ctxTemplate=m
 *   3. FALLBACK: first Task call   → vC7.call() entry → _capture(M) + _callSelf
 *                sets _callSelf (no-op if already set), refreshes _ctxTemplate
 *
 * Both _primed and _callSelf flip automatically with no human intervention:
 *   - _callSelf: set at bundle init via AHH() registration hook
 *   - _primed:   set on first user prompt via bm4() early prime
 * invoke() becomes callable as soon as the user has sent their first message.
 *
 * The heartbeat dispatcher should check:
 *   if (!agentTool._primed || !agentTool._callSelf) return; // not ready yet
 *
 * ── toolUseContext fields filled vs stubbed ──────────────────────────────────
 *
 * Filled from snapshotted template (m at first user prompt):
 *   getAppState, getToolPermissionContext, options (tools, agentDefinitions,
 *   mainLoopModel, querySource, etc.), agentLifecycle, getReplContexts,
 *   setReplContext, messages (copied empty []), taskRegistry, abortSpeculation
 *
 * Filled fresh for each invoke() call:
 *   agentId       — new uuid via crypto.randomUUID (fresh per dispatch)
 *   abortController — new AbortController tied to timeoutMs
 *   toolUseId     — derived from agentId ("ccp_bg_<uuid>")
 *
 * Stubbed (no-ops, safe to omit for background-only calls):
 *   setToolJSX, emitToolProgress, setMessages, applyMessageOp,
 *   addResponseLength, renderedSystemPrompt (undefined)
 *
 * ── Public surface ───────────────────────────────────────────────────────────
 *
 * globalThis.__ccpAgentTool.invoke({
 *   subagent_type : string,    // e.g. "trading-analyst"
 *   prompt        : string,    // forwarded as-is to the subagent
 *   description?  : string,    // short label (default: "heartbeat task")
 *   background?   : boolean,   // default true — takes the async path
 *   model?        : string,    // optional model override
 *   timeoutMs?    : number,    // default 120_000
 * }) → Promise<{
 *   text        : string,
 *   durationMs  : number,
 *   agentType   : string,
 *   runId       : string,
 * }>
 *
 * The promise rejects with:
 *   { code: 'not-yet-primed' }  — no user prompt has run in this session yet
 *   { code: 'no-agent-tool' }   — _callSelf not yet set (should not occur in normal sessions)
 *   { code: 'timeout', ms: N }  — call exceeded timeoutMs
 *   { code: 'agent-error', message: string } — bundle threw synchronously
 *
 * ── Heartbeat integration note ───────────────────────────────────────────────
 *
 * Check readiness via:
 *   const agentTool = globalThis.__ccpAgentTool;
 *   if (!agentTool?._primed || !agentTool?._callSelf) return; // not ready yet
 *   const result = await agentTool.invoke({
 *     subagent_type: task.subagent,
 *     prompt: task.input,
 *     description: task.description ?? 'heartbeat task',
 *     background: true,
 *     timeoutMs: task.timeoutMs ?? 120_000,
 *   });
 *   // result.text is the subagent's final output
 */

export default {
  category: 'expose',

  description: 'Expose native AgentTool (vC7.call) via globalThis.__ccpAgentTool for background heartbeat dispatch.',
  capabilities: ["tools"],
  dependsOn: ['subagent_hooks_stub'],
  // G3: strengthened from present-only to a real count. Both present strings are
  // asserted, and count.present pins the TOTAL occurrences across them.
  //   - '_ccpBootErr_' = 3 (bootstrap IIFE catch + provide try/catch text):
  //     validated stable at 3 after a correct apply (0 before).
  //   - 'globalThis.__ccpAgentTool?._capture?.(' = 1 once the G2 early-prime
  //     re-anchor lands — asserts the re-anchor succeeded (it is the ONLY
  //     occurrence of this optional-chain capture call; the bootstrap uses
  //     `this._capture(`/`._capture(` forms instead, which do not match).
  // checkVerifyCore sums count.present across ALL present strings, so the pinned
  // total is 3 + 1 = 4. Validated by applying apply() to the 2.1.156 bundle and
  // counting (see /tmp/verify_g3.mjs): _ccpBootErr_=3, capture-call=1.
  verify: {
    present: ['_ccpBootErr_', 'globalThis.__ccpAgentTool?._capture?.('],
    count: { present: 4 },
    label: 'Expose AgentTool',
  },

  apply: (code) => {
    // Idempotency guard: check for a string that only exists when this patch's bootstrap was applied.
    // Using '_ccpBootErr_' which is unique to this patch's IIFE catch block.
    if (code.includes('_ccpBootErr_')) return code;

    // ── 1. BOOTSTRAP — inject __ccpAgentTool placeholder at module top ────────
    // Anchored on the CJS-IIFE shebang (normalizer prepends it before patches run).
    const bootstrapCode = `
// ── [PATCH] expose_agent_tool: __ccpAgentTool bootstrap ──────────────────────
// Make fs available to debug code regardless of CJS/ESM mode. Top-level
// dynamic import resolves before any heartbeat tick fires.
try { import('node:fs').then(function(m){ globalThis.__ccpFs = m; }).catch(function(){}); } catch (_) {}
try {
  if (!globalThis.__ccpAgentTool) {
    globalThis.__ccpAgentTool = {
      _primed: false,
      _callSelf: null,
      _ctxTemplate: null,

      /**
       * _capture(ctxLike) — idempotent context snapshot.
       * Called from the early prime (bm4 query loop) and the fallback prime
       * (vC7.call entry). Whichever fires first wins for _ctxTemplate.
       * Always refreshes _ctxTemplate so tools/agentDefinitions stay current.
       * Only flips _primed once.
       */
      _capture(ctxLike) {
        try {
          if (!ctxLike) return;
          // ── Guard against MCP-stripping captures ──────────────────────────
          // Subagent vC7.call() invocations pass a filtered ctx (only the agent's
          // declared tools, no MCPs). If we overwrite our good template with
          // that, the next heartbeat builds bgCtx with 0 MCP tools.
          // Prefer ctxs with MORE tools (richer registry).
          var __newTools = Array.isArray(ctxLike?.options?.tools) ? ctxLike.options.tools.length : 0;
          var __oldTools = Array.isArray(this._ctxTemplate?.options?.tools) ? this._ctxTemplate.options.tools.length : 0;
          if (this._ctxTemplate && __newTools < __oldTools) {
            // New ctx is poorer — likely from subagent dispatch. Skip overwrite.
            return;
          }
          this._ctxTemplate = ctxLike;
          if (!this._primed) {
            this._primed = true;
          }
        } catch (_ccpCapErr_) {}
      },

      /**
       * invoke({ subagent_type, prompt, description, background, model, timeoutMs })
       * → Promise<{ text, durationMs, agentType, runId }>
       */
      invoke({ subagent_type, prompt, description = 'heartbeat task', background = true, model, timeoutMs = 120000 } = {}) {
        if (!this._primed || !this._ctxTemplate) {
          return Promise.reject(Object.assign(new Error('AgentTool not yet primed — no user prompt has run in this session'), { code: 'not-yet-primed' }));
        }
        if (!this._callSelf) {
          return Promise.reject(Object.assign(new Error('AgentTool _callSelf not yet captured — no Task has been dispatched in this session'), { code: 'no-agent-tool' }));
        }
        const _self = this;
        return new Promise((resolve, reject) => {
          const runId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).slice(2);
          const startMs = Date.now();
          const abortCtrl = new AbortController();
          // ── ccpatch bus: agent.spawn + agent_path threading ────────────────
          // Stamp the global path so any tool.call emitted inside the subagent's
          // execution carries the right agent_path. Restored in both then/catch.
          const __ccp_parent_path = globalThis.__ccp_path || 'root';
          const __ccp_child_id = 'agent-' + runId;
          const __ccp_prev_path = globalThis.__ccp_path;
          globalThis.__ccp_path = __ccp_parent_path + '/' + __ccp_child_id;
          try {
            globalThis.__ccpBus && globalThis.__ccpBus.emit('agent.spawn', {
              parent_id: __ccp_parent_path,
              child_id: __ccp_child_id,
              prompt: prompt,
            });
          } catch (_ccpAS_) {}
          const timer = setTimeout(() => {
            abortCtrl.abort();
            reject(Object.assign(new Error('AgentTool invoke timed out after ' + timeoutMs + 'ms'), { code: 'timeout', ms: timeoutMs }));
          }, timeoutMs);

          // Build a lightweight context overlay on top of the snapshotted template.
          // We only override the fields that must be fresh per-invocation.
          const tmpl = _self._ctxTemplate;
          // Resolve a non-null mainLoopModel — vC7.call -> nMH -> PB$ -> Z71
          // calls startsWith on options.mainLoopModel. Null crashes it.
          // Also expand short aliases (sonnet, opus, haiku) since subagent
          // path does NOT alias-resolve before hitting the API → 404 otherwise.
          let resolvedModel = tmpl.options?.mainLoopModel;
          if (!resolvedModel || typeof resolvedModel !== 'string') {
            try {
              const live = tmpl.getAppState?.();
              resolvedModel = live?.mainLoopModel ?? live?.options?.mainLoopModel ?? null;
            } catch (_ccpModelErr_) {}
          }
          // Alias expansion table (kept simple — CC's main-loop resolver runs
          // earlier but the subagent path bypasses it). Aliases are mapped
          // to currently-shipping full model IDs.
          const __ALIAS_MAP__ = {
            'sonnet':  'claude-sonnet-4-5-20250929',
            'opus':    'claude-opus-4-1-20250805',
            'haiku':   'claude-haiku-4-5-20251001',
            'default': 'claude-sonnet-4-5-20250929',
          };
          if (typeof resolvedModel === 'string' && __ALIAS_MAP__[resolvedModel.toLowerCase()]) {
            resolvedModel = __ALIAS_MAP__[resolvedModel.toLowerCase()];
          }
          if (!resolvedModel || typeof resolvedModel !== 'string') {
            resolvedModel = 'claude-sonnet-4-5-20250929';
          }
          // PREFER tmpl.options.mcpClients AS-IS — if a real user Task call has
          // captured the live ctx, these are working clients with sockets. Only
          // fall back to refresh if they're empty.
          let liveMcpClients = tmpl.options?.mcpClients;
          let liveMcpResources = tmpl.options?.mcpResources;
          if (!Array.isArray(liveMcpClients) || liveMcpClients.length === 0) {
            try {
              if (typeof tmpl.options?.refreshMcpClients === 'function') {
                const refreshed = tmpl.options.refreshMcpClients();
                if (Array.isArray(refreshed) && refreshed.length > 0) {
                  liveMcpClients = refreshed;
                }
              }
            } catch (_ccpRMcp_) {}
          }
          // Tools: prefer tmpl.options.tools as-is too (real ctx is best)
          let liveTools = tmpl.options?.tools;
          if (!Array.isArray(liveTools) || liveTools.length < 50) {
            try {
              if (typeof tmpl.options?.refreshTools === 'function') {
                const refreshed = tmpl.options.refreshTools();
                if (Array.isArray(refreshed) && refreshed.length >= (Array.isArray(liveTools) ? liveTools.length : 0)) {
                  liveTools = refreshed;
                }
              }
            } catch (_ccpRTErr_) {}
          }
          // Normalize MCP client wrappers: claude.ai clients have callTool on .client, not the wrapper
          if (Array.isArray(liveMcpClients)) {
            liveMcpClients = liveMcpClients.map(function(c) {
              if (c && typeof c.callTool !== 'function' && c.client && typeof c.client.callTool === 'function') {
                return Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
                  callTool: function(name, args, opts) { return c.client.callTool(name, args, opts); }
                });
              }
              return c;
            });
          }
          const bgCtx = {
            ...tmpl,
            agentId: runId,
            toolUseId: 'ccp_bg_' + runId,
            abortController: abortCtrl,
            // No TUI for background calls — stub these out safely
            setToolJSX: undefined,
            emitToolProgress: undefined,
            renderedSystemPrompt: undefined,
            addResponseLength: () => {},
            messages: tmpl.messages ? [] : undefined,
            // Defensively override options with fresh model + live MCP state.
            options: {
              ...(tmpl.options || {}),
              mainLoopModel: resolvedModel,
              tools: liveTools,
              mcpClients: liveMcpClients,
              mcpResources: liveMcpResources,
            },
          };

          // Fire subagent:dispatch so TUI status line lights up
          try {
            if (globalThis.__ccpSubagent) {
              globalThis.__ccpSubagent.emit('subagent:dispatch', {
                agentType: subagent_type,
                model: model,
                source: 'heartbeat',
                isAsync: background,
                isFork: false,
                ts: Date.now(),
              });
            }
          } catch (_ccpE_) {}

          // Input args match vC7.call() destructured params:
          // { prompt, subagent_type, description, model, run_in_background, name, team_name, mode, isolation, cwd }
          const inputArgs = {
            prompt,
            subagent_type,
            description,
            model: model || undefined,
            run_in_background: background,
            name: undefined,
            team_name: undefined,
            mode: undefined,
            isolation: undefined,
            cwd: undefined,
          };

          // Stub requestContext (D) and progressCallback (j) — safe to be minimal
          const requestCtx = { requestId: 'ccp_bg_req_' + runId, message: { id: 'ccp_bg_msg_' + runId } };
          const progressCb = null;

          // vC7.call returns a Promise (from async function)
          // ───────────────────────────────────────────────────────────────────
          // SECURITY: the third positional arg to call() is canUseTool, the
          // permission gate Claude Code consults before running each tool. In an
          // interactive session it renders an allow/deny prompt in the TUI. The
          // background dispatch path here is HEADLESS by construction — there is
          // no TUI surface (setToolJSX/emitToolProgress are stubbed to undefined
          // above), so the real interactive callback would block forever waiting
          // on a prompt nobody can answer. We therefore pass () => true, which
          // INTENTIONALLY DISABLES the permission gate for any subagent spawned
          // via __ccpAgentTool.invoke(): such subagents run every tool (Bash,
          // Write, Edit, MCP, …) with NO allow/deny prompt — a privilege
          // escalation beyond the interactive CLI. This is why expose_agent_tool
          // is OFF by default, and why (in combination with headless_bridge) the
          // bridge token is documented as root-equivalent. See THREAT_MODEL.md
          // (expose_agent_tool / bridge entries) for the full disclosure.
          Promise.resolve()
            .then(() => _self._callSelf(inputArgs, bgCtx, /* canUseTool — see SECURITY note above: gate intentionally bypassed for headless dispatch */ () => true, requestCtx, progressCb))
            .then((result) => {
              clearTimeout(timer);
              const text = (result && result.data && typeof result.data.result === 'string')
                ? result.data.result
                : (result && typeof result === 'object' ? JSON.stringify(result) : String(result ?? ''));
              // Fire subagent:result so __ccpSubagent subscribers are notified
              try {
                if (globalThis.__ccpSubagent) {
                  globalThis.__ccpSubagent.emit('subagent:result', { result: text, messages: [], defaultLabel: description });
                }
              } catch (_ccpE_) {}
              // ── ccpatch bus: agent.exit (ok) + restore path ────────────────
              try {
                globalThis.__ccpBus && globalThis.__ccpBus.emit('agent.exit', {
                  id: __ccp_child_id,
                  ok: true,
                  usage: (result && result.usage) || null,
                });
              } catch (_ccpAE_) {}
              globalThis.__ccp_path = __ccp_prev_path;
              resolve({ text, durationMs: Date.now() - startMs, agentType: subagent_type, runId });
            })
            .catch((err) => {
              clearTimeout(timer);
              // ── ccpatch bus: agent.exit (fail) + restore path ──────────────
              try {
                globalThis.__ccpBus && globalThis.__ccpBus.emit('agent.exit', {
                  id: __ccp_child_id,
                  ok: false,
                  usage: null,
                });
              } catch (_ccpAEx_) {}
              globalThis.__ccp_path = __ccp_prev_path;
              if (abortCtrl.signal.aborted) return; // already rejected via timeout
              // Preserve err.stack so the dispatcher's outbox finding shows the
              // real failure site instead of just the message.
              const msg = (err?.message ?? String(err)) + '\\n' + (err?.stack ?? '');
              reject(Object.assign(new Error(msg), { code: 'agent-error', cause: err }));
            });
        });
      },
    };
    // ── Contract registration ──────────────────────────────────────────────
    // Consumers (prime_agent_tool_on_boot, heartbeat dispatchers, etc.) can
    // call __ccpRequire('agentTool', { consumer, minVersion: 1, shape: ['_capture','invoke'] })
    // to surface a loud error if the bootstrap somehow shipped without _capture.
    if (typeof globalThis.__ccpProvide === 'function') {
      try {
        globalThis.__ccpProvide('agentTool', {
          version: 1,
          producer: 'expose_agent_tool',
          shape: ['_capture', 'invoke'],
          value: globalThis.__ccpAgentTool,
        });
      } catch (_ccpAT_prov_) {}
    }
  }
} catch (_ccpBootErr_) {
  try { console.warn('[expose_agent_tool] bootstrap error:', _ccpBootErr_?.message ?? _ccpBootErr_); } catch (_) {}
}
`;

    const shebangAnchor = '#!/usr/bin/env node';
    const cjsIifeAnchor = '(function(exports, require, module, __filename, __dirname) {';
    if (code.includes(shebangAnchor)) {
      code = code.replace(shebangAnchor, shebangAnchor + '\n' + bootstrapCode);
    } else if (code.includes(cjsIifeAnchor)) {
      code = code.replace(cjsIifeAnchor, () => cjsIifeAnchor + bootstrapCode);
    } else {
      console.warn('  [!] expose_agent_tool: neither shebang nor CJS-IIFE anchor found for bootstrap — skipping');
      return code;
    }

    // ── 2a. REGISTRATION — capture AgentTool ref at bundle init ─────────────
    // Anchor history:
    //   v2.1.139: function me(){return[ZR7,cY8,
    //   v2.1.140: function AHH(){return[vC7,
    //   v2.1.146: function Ur(){return[no7,           (no7 = NK({async call,...}))
    // The registry function name and AgentTool identifier rotate; we capture
    // them by matching the shape `function <REG>(){return[<TOOL0>,<TOOL1>,`.
    // Disambiguation: this is the ONLY function whose returned array's first
    // element wraps an async `call({prompt:H,subagent_type:` method, but the
    // registry shape alone (2+ comma-separated identifiers in a return array)
    // is unique enough at module scope to anchor on. We then verify by checking
    // that the first identifier resolves to a NK(...) or {...async call({prompt:
    // declaration upstream.
    const regRe = /function ([A-Za-z_$][\w$]*)\(\)\{return\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),/;
    const regMatch = code.match(regRe);
    if (!regMatch) {
      console.warn('  [!] expose_agent_tool: registration anchor (tools registry) not found — _callSelf captured only on first Task call');
    } else {
      const [, REG, TOOL0] = regMatch;
      // Sanity check: the registry must contain a tool whose declaration has an
      // `async call({prompt:` signature within the AgentTool's NK(...) wrapper.
      // We use the call sig presence as the verification gate (same gate as
      // anchor #3 below).
      const hasCallSig = /async call\(\{prompt:[A-Za-z_$][\w$]*,subagent_type:/.test(code);
      if (!hasCallSig) {
        console.warn('  [!] expose_agent_tool: tools registry found but AgentTool call() shape unrecognized — skipping registration');
      } else {
        const regCaptureFn = 'function _ccpCaptureTool_(t){try{if(globalThis.__ccpAgentTool&&!globalThis.__ccpAgentTool._callSelf&&t&&t.call){globalThis.__ccpAgentTool._callSelf=(a,c,x,y,z)=>t.call(a,c,x,y,z);}}catch(_ccpCT_){}}';
        const regReplacement = `${regCaptureFn}function ${REG}(){try{_ccpCaptureTool_(${TOOL0});}catch(_ccpReg_){}return[${TOOL0},`;
        code = code.replace(`function ${REG}(){return[${TOOL0},`, regReplacement);
      }
    }

    // ── 2. EARLY PRIME — capture toolUseContext on first user prompt ──────────
    // Anchor history:
    //   v2.1.139: let m=Z();for(let F=0;F<R.length;F++){
    //   v2.1.140: let m=Z();for(let F=0;F<C.length;F++){
    //   v2.1.146: let x=G();for(let Q=0;Q<C.length;Q++){
    //   v2.1.156: let x=Z();for(let U=0;U<I.length;U++){   (loop-array renamed C→I)
    // The local var, accessor fn, loop index AND the input-batch array name all
    // rotate. On 2.1.156 the loop array is no longer literally `C` (it's `I`),
    // so the old `C.length`-pinned regex misses and the patch falls back to
    // AgentTool.call() only — defeating prime-on-boot.
    //
    // Tier 1 (primary): generalize the loop array to a captured group and match
    // ALL such loops globally. The defining property of the early-prime loop is
    // that the context var (`let CTX=FN()`) is DISTINCT from the array being
    // iterated (`CTX !== ARR`) — the bm4 query loop snapshots a fresh ctx then
    // iterates a separate input batch. The decoy loop (`let H=Bb$();...H.length`)
    // iterates its own array, so CTX===ARR filters it out. Validated on 2.1.156:
    // exactly ONE match satisfies CTX!==ARR — the `let x=Z();for(let U=0;U<I.length;U++){`
    // loop. The replacement injects the capture using the CAPTURED array name
    // (`${ARR}`), never a literal.
    //
    // Tier 2 (fallback): the historical `C.length`-literal form, retained for
    // older bundles where the loop array is literally `C`.
    const earlyGlobalRe = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\);for\(let ([A-Za-z_$][\w$]*)=0;\3<([A-Za-z_$][\w$]*)\.length;\3\+\+\)\{/g;
    const earlyCandidates = [];
    let __em;
    while ((__em = earlyGlobalRe.exec(code)) !== null) {
      const [whole, CTXVAR, CTXFN, LOOPVAR, ARR] = __em;
      if (CTXVAR !== ARR) earlyCandidates.push({ whole, CTXVAR, CTXFN, LOOPVAR, ARR });
    }
    if (earlyCandidates.length === 1) {
      // Primary tier: unique CTX!==ARR loop. Use the captured array name.
      const { whole, CTXVAR, CTXFN, LOOPVAR, ARR } = earlyCandidates[0];
      const earlyReplacement = `let ${CTXVAR}=${CTXFN}();try{globalThis.__ccpAgentTool?._capture?.(${CTXVAR});}catch(_ccpEP_){}for(let ${LOOPVAR}=0;${LOOPVAR}<${ARR}.length;${LOOPVAR}++){`;
      code = code.replace(whole, earlyReplacement);
    } else {
      // Fallback tier: historical `C.length`-literal form.
      const earlyRe = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\);for\(let ([A-Za-z_$][\w$]*)=0;\3<C\.length;\3\+\+\)\{/;
      const earlyMatch = code.match(earlyRe);
      if (!earlyMatch) {
        if (earlyCandidates.length > 1) {
          console.warn(`  [!] expose_agent_tool: early prime anchor ambiguous (${earlyCandidates.length} CTX!==ARR loops) and no C.length fallback — falling back to AgentTool.call() only`);
        } else {
          console.warn('  [!] expose_agent_tool: early prime anchor (bm4-style query loop) not found — falling back to AgentTool.call() only');
        }
      } else {
        const [earlyWhole, CTXVAR, CTXFN, LOOPVAR] = earlyMatch;
        const earlyReplacement = `let ${CTXVAR}=${CTXFN}();try{globalThis.__ccpAgentTool?._capture?.(${CTXVAR});}catch(_ccpEP_){}for(let ${LOOPVAR}=0;${LOOPVAR}<C.length;${LOOPVAR}++){`;
        code = code.replace(earlyWhole, earlyReplacement);
      }
    }

    // ── 3. FALLBACK PRIME — snapshot on first AgentTool.call() ───────────────
    // Anchor history (the internal English property names are stable; outer
    // single-letter param identifiers and their order rotate):
    //   v2.1.140: async call({...,cwd:O},M,w,D,j){
    //   v2.1.146: async call({...,cwd:O},M,w,j,D){   (D and j swapped)
    // Match the destructure prefix (stable) + capture the tail param names.
    const callRe = /(async call\(\{prompt:([A-Za-z_$][\w$]*),subagent_type:[A-Za-z_$][\w$]*,description:[A-Za-z_$][\w$]*,model:[A-Za-z_$][\w$]*,run_in_background:[A-Za-z_$][\w$]*,name:[A-Za-z_$][\w$]*,team_name:[A-Za-z_$][\w$]*,mode:[A-Za-z_$][\w$]*,isolation:[A-Za-z_$][\w$]*,cwd:[A-Za-z_$][\w$]*\},([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{)/;
    const callMatch = code.match(callRe);
    if (!callMatch) {
      console.warn('  [!] expose_agent_tool: call() signature anchor not found — _callSelf will not be captured');
      return code;
    }
    const [callSig, , , CTX] = callMatch;
    // We need the AgentTool identifier for `_callSelf = (args, ctx, a, b, c) => TOOL.call(...)`.
    // Reuse the TOOL0 from registration when available; otherwise fall back to
    // the (older) module-scope name. The tool identifier appears directly
    // before the `={async prompt...async call(` declaration block.
    const toolRe = /([A-Za-z_$][\w$]*)=(?:NK|\{)[^=]*async call\(\{prompt:[A-Za-z_$][\w$]*,subagent_type:/;
    const toolMatch = code.match(toolRe);
    const TOOL = toolMatch ? toolMatch[1] : (regMatch ? regMatch[2] : 'vC7');

    const fallbackInjection = `
try {
  // Always refresh context template so tools/agentDefinitions stay current.
  if (globalThis.__ccpAgentTool) {
    globalThis.__ccpAgentTool._capture(${CTX});
    // Capture AgentTool closure reference for invoke() — only available inside call().
    if (!globalThis.__ccpAgentTool._callSelf) {
      globalThis.__ccpAgentTool._callSelf = (args, ctx, a, b, c) => ${TOOL}.call(args, ctx, a, b, c);
    }
  }
} catch (_ccpPrimeErr_) {}
`;

    code = code.replace(callSig, callSig + fallbackInjection);

    return code;
  },
};

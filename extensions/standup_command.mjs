// @ts-check
/**
 * standup_command — native `/standup` slash command that rewrites the prompt.
 *
 * When the user types `/standup` (or `/standup <N>` for N days, default 1) into
 * the prompt bar and submits, this patch REWRITES the submitted text into a
 * generated prompt containing recent git activity, then lets the normal turn
 * proceed — Claude (the model) writes the standup summary. It does NOT print
 * locally and it does NOT block the turn.
 *
 * ── Why not slash_dispatch? ───────────────────────────────────────────────────
 * slash_dispatch waits for globalThis.__ccpOnUserPromptSubmit, which nothing in
 * the repo publishes — so the typed-`/command` path never fires. This patch is
 * SELF-CONTAINED: it hooks the SAME React submit useCallback that
 * expose_submit_input captures, intercepts the queued-commands argument before
 * the original callback runs, detects a leading `/standup`, and rewrites that
 * command's `value` / `preExpansionValue` to the generated prompt (stripping the
 * slash so it is sent as a normal prompt, never re-dispatched as a command).
 * expose_submit_input is NOT required.
 *
 * ── Anchor strategy ───────────────────────────────────────────────────────────
 * Structural regex on the submit useCallback shape (NOT minified names, rule 1):
 *   let <var>=<React>.useCallback(async(<arg>)=>{await <inner>({helpers:{
 * The trailing `{helpers:{` disambiguates the submit handler from every other
 * useCallback(async ...) site. Verified unique (1×) in both the pristine
 * cli.v2.1.177.cjs and the already-patched cli.v2.1.177.patched.mjs (rule 9).
 * We wrap the callback expression: capture the original async callback, install
 * an adapter that rewrites `/standup` queued commands, then delegate.
 *
 * The git-shelling + prompt composition lives in _standup_command_shim.mjs
 * (rule 6; underscore-prefixed so the patch loader does not treat it as a
 * patch); the bundle injection below carries a self-contained inline copy
 * (the CJS bundle cannot import an .mjs at runtime) and only a thin wrapper of
 * intercept logic. Both are kept in lockstep and exercised by the test suite.
 */

/** @type {import('../types/patch').Patch} */
export default {
  category: 'optional',
  enabled: false,

  description: 'Native /standup slash command — rewrite the prompt with recent git activity for a standup summary',
  capabilities: ['prompt', 'exec'],

  // The sentinel `__ccpStandupCommand_v1` appears exactly 4× after a correct
  // apply: (1) the `var __ccpStandupCommand_v1=!0;` guard assignment,
  // (2) the composer-install guard `if(!globalThis.__ccpStandupCommand_v1BuildPrompt)`,
  // (3) the composer assignment `globalThis.__ccpStandupCommand_v1BuildPrompt=function`,
  // (4) the adapter call `globalThis.__ccpStandupCommand_v1BuildPrompt(__v)`.
  // count: makes this a STRONG verify (rule 3) — it pins both that the patch
  // landed AND that it landed exactly once (re-apply can't double-inject).
  verify: {
    present: '__ccpStandupCommand_v1',
    count: { present: 4 },
  },

  // No dependency: self-contained. Declared to coordinate with the other
  // submit-callback consumer so the runner orders/overlap-checks them.
  allowOverlapWith: ['expose_submit_input'],

  apply: (code) => {
    const SENTINEL = '__ccpStandupCommand_v1';
    // Idempotency (rule 2): re-apply on an already-patched bundle is a
    // byte-identical no-op.
    if (code.includes(SENTINEL)) return code;

    // Structural anchor — match the submit useCallback shape, never the
    // minified identifiers (rule 1).
    const re = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.useCallback\(async\(([A-Za-z_$][\w$]*)\)=>\{await ([A-Za-z_$][\w$]*)\(\{helpers:\{/;
    const m = code.match(re);
    if (!m) {
      // Fail loud, fail open (rule 4) — return code unchanged, never throw.
      console.warn('  [!] standup_command: submit useCallback anchor not found — /standup disabled');
      return code;
    }

    const [, varName, ReactNs, argName, innerFn] = m;
    const ucPrefix = `${ReactNs}.useCallback(`;
    const anchor = `let ${varName}=${ReactNs}.useCallback(async(${argName})=>{await ${innerFn}(`;

    // Replacement wraps the callback expression. We:
    //   1. capture the original callback (__ccpCb),
    //   2. install a __ccpStandupBuildPrompt composer global once,
    //   3. return an adapter that, for each queued command, detects /standup
    //      and rewrites value/preExpansionValue to the generated prompt before
    //      delegating to the original callback.
    // Everything is wrapped in try/catch and falls through to the original
    // callback on any error (fail open, rule 4).
    const replacement =
      `var ${SENTINEL}=!0;` +
      `let ${varName}=(function(__ccpCb){` +
        `try{` +
          // ── composer: git activity → standup prompt (inline copy of shim) ──
          `if(!globalThis.${SENTINEL}BuildPrompt){` +
            `globalThis.${SENTINEL}BuildPrompt=function(__raw){` +
              `try{` +
                `var __re=/^\\/standup(?:\\s+(\\d+))?\\s*$/i;` +
                `var __mm=__re.exec(String(__raw||"").trim());` +
                `if(!__mm)return null;` +
                `var __days=Math.max(1,__mm[1]?(parseInt(__mm[1],10)||1):1);` +
                `var __dw=__days===1?"day":"days";` +
                `var __cp=null;try{__cp=require("node:child_process");}catch(_a){try{__cp=require("child_process");}catch(_b){__cp=null;}}` +
                `var __instr="Write a concise daily standup update (Yesterday / Today / Blockers) from the git activity above. Keep it to a few bullet points per section.";` +
                `function __git(__args){try{var __o=__cp.execFileSync("git",__args,{cwd:process.cwd(),encoding:"utf8",timeout:5000,maxBuffer:4194304,stdio:["ignore","pipe","ignore"]});return typeof __o==="string"?__o.trim():null;}catch(_g){return null;}}` +
                `if(!__cp){return "Recent git activity for the last "+__days+" "+__dw+":\\n(git data was unavailable — child_process could not be loaded.)\\n\\n"+__instr;}` +
                `var __since=__days+" "+__dw+" ago";` +
                `var __log=__git(["log","--since="+__since,"--pretty=format:%h %s"]);` +
                `var __churn=__git(["diff","--stat","@{"+__days+".days.ago}"]);` +
                `if(__churn==null){__churn=__git(["log","--since="+__since,"--shortstat","--pretty=format:"]);if(__churn!=null){__churn=__churn.replace(/\\n{2,}/g,"\\n").trim();}}` +
                `var __isRepo=__git(["rev-parse","--is-inside-work-tree"])==="true";` +
                `if(!__isRepo){return "Recent git activity for the last "+__days+" "+__dw+":\\n(git data was unavailable — not a git repository, or git is not installed.)\\n\\n"+__instr;}` +
                `var __cb=(__log&&__log.length)?__log:"(no commits in this window)";` +
                `var __chb=(__churn&&__churn.length)?__churn:"(no diff stats available)";` +
                `return "Recent git activity for the last "+__days+" "+__dw+" (generated by the /standup command):\\n\\nCommits:\\n"+__cb+"\\n\\nChurn:\\n"+__chb+"\\n\\n"+__instr;` +
              `}catch(_e){return "Recent git activity:\\n(git data was unavailable — an internal error occurred while gathering it.)\\n\\nWrite a concise daily standup update (Yesterday / Today / Blockers) from the git activity above.";}` +
            `};` +
          `}` +
          // ── adapter: rewrite /standup queued commands, then delegate ──
          `var __ccpStandupAdapter=function(__qc){` +
            `try{` +
              `var __arr=Array.isArray(__qc)?__qc:(__qc!=null?[__qc]:[]);` +
              `for(var __i=0;__i<__arr.length;__i++){` +
                `var __it=__arr[__i];if(!__it||typeof __it!=="object")continue;` +
                `var __v=(typeof __it.value==="string")?__it.value:((typeof __it.preExpansionValue==="string")?__it.preExpansionValue:"");` +
                `var __np=globalThis.${SENTINEL}BuildPrompt(__v);` +
                `if(typeof __np==="string"){` +
                  // Rewrite to a normal prompt. skipSlashCommands:true ensures the
                  // generated text is never re-parsed as a slash command.
                  `__it.value=__np;__it.preExpansionValue=__np;` +
                  `if("mode" in __it)__it.mode="prompt";` +
                  `__it.skipSlashCommands=true;` +
                `}` +
              `}` +
            `}catch(_e){}` +
            `return __ccpCb(__qc);` +
          `};` +
          `return __ccpStandupAdapter;` +
        `}catch(_ccpSU_){}` +
        `return __ccpCb;` +
      // Re-emit the ENTIRE original callback expression (everything after
      // `let <var>=`) as the IIFE argument — including the async arrow head and
      // the `await <inner>(` we matched. The original body continues unchanged.
      `})(${anchor.slice(anchor.indexOf('=') + 1)}`;

    code = code.replace(anchor, replacement);

    // Paren-count to find the matching close of the original useCallback(...)
    // and append the extra `)` that closes the wrapper IIFE call.
    const ucStart = code.indexOf(ucPrefix, code.indexOf(SENTINEL + '=!0;'));
    if (ucStart < 0) {
      console.warn('  [!] standup_command: useCallback start not found post-replace — bailing');
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
      console.warn('  [!] standup_command: useCallback close not found — bailing');
      return code;
    }

    code = code.slice(0, endIdx) + ')' + code.slice(endIdx);
    return code;
  },
};

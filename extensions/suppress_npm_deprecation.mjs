/**
 * suppress_npm_deprecation — Hide the "switched from npm to native installer"
 * startup banner.
 *
 * Claude Code emits this warning when it detects it was installed via npm
 * rather than the native binary installer.  When running a ccpatch-patched
 * bundle the installer-type detection is meaningless — the bundle was
 * extracted and re-emitted by ccpatch, not by any installer.  The banner is
 * noise for all ccpatch users.
 *
 * The warning object in the bundle looks like:
 *   {id:"npm-deprecation",tier:"warning",type:"warning",
 *    isActive:(H)=>H.npmInstallDeprecated, render:...}
 *
 * We replace the isActive predicate with ()=>false so the warning is never
 * shown.  The anchor is the full id+tier+type+isActive prefix — unique in the
 * bundle and stable across minifier renaming (the string literals are fixed).
 */

const ANCHOR =
  'id:"npm-deprecation",tier:"warning",type:"warning",isActive:(e)=>e.npmInstallDeprecated';
const PATCHED =
  'id:"npm-deprecation",tier:"warning",type:"warning",isActive:()=>false';

export default {
  category: 'fix',
  description: 'Suppress the "switched from npm to native installer" startup warning (irrelevant for patched bundles)',
  capabilities: [],
  verify: {
    absent: 'isActive:(e)=>e.npmInstallDeprecated',
    present: 'isActive:()=>false',
  },
  apply: (code) => {
    if (!code.includes(ANCHOR)) {
      console.warn('  [!] suppress_npm_deprecation: anchor not found — warning not suppressed');
      return code;
    }
    return code.replace(ANCHOR, PATCHED);
  },
};

import { ccpLog } from '../runner/cli/style.mjs';

export default {
  category: 'fix',

  description: 'Truncate oversized system-message content before lZ7 renders it, preventing terminal crash',
  capabilities: ["prompt"],
  verify: {
    present: 'length>50000',
    // Validated against cli.v2.1.156.cjs: only the general content path anchor
    // matches on this bundle, injecting `Y.length>50000` exactly once. The
    // away_summary italic anchor (a second `length>50000`) is absent here.
    count: { present: 1 },
  },
  apply: (code) => {
    // The lZ7 system-message renderer can crash on extremely large content
    // (100KB+ from tool results or hook output) — Ink's text-measurement/layout
    // chokes. This patch wraps two render paths with a truncation IIFE.

    const MAX = 50_000;
    let result = code;

    // First anchor: guard the general content rendering path (the gN_/lZ7
    // renderer call-site, ~line 5514). The component name has rotated across
    // versions (ah_ → ox_ → A45 → gN_) and the *property keys*
    // {content,addMargin,dot,color,dimColor} are stable — but the minified
    // *local variable* names bound to them rotate every release, and even
    // reorder (dot/color swapped f↔O between 2.1.156 → 2.1.158). Capture the
    // component identifier and all five binding names so the patch survives
    // rotation instead of pinning literals that drift out from under it.
    // The leading `COMP,` requirement excludes the component *definition* site
    // (`...c(17),{content:...}`), whose preceding `)` is not an identifier char.
    const callRe = /([A-Za-z_$][\w$]*),\{content:([A-Za-z_$][\w$]*),addMargin:([A-Za-z_$][\w$]*),dot:([A-Za-z_$][\w$]*),color:([A-Za-z_$][\w$]*),dimColor:([A-Za-z_$][\w$]*)\}/;
    const callMatch = result.match(callRe);
    let result2 = result;
    if (callMatch) {
      const [anchor2, COMP, C, AM, DOT, COL, DC] = callMatch;
      const guarded = `(typeof ${C}==="string"&&${C}.length>${MAX}?${C}.slice(0,${MAX})+"\\u2026[truncated "+(${C}.length-${MAX})+" chars]":${C})`;
      const patched2 = `${COMP},{content:${guarded},addMargin:${AM},dot:${DOT},color:${COL},dimColor:${DC}}`;
      result2 = result.split(anchor2).join(patched2);
      ccpLog(`  [large-content-guard] ${COMP} general content path protected (max ${MAX} chars)`);
    } else {
      console.warn('  [!] large-content-guard: general content anchor not found — content path unprotected');
    }

    // Second anchor: raw bundle — away_summary content rendered as italic text block
    // Stable across versions: the structural createElement pattern for recap content display
    const anchor3 = 'N6.createElement(k,{dimColor:!0,italic:!0},q.content)';
    const patched3 = `N6.createElement(k,{dimColor:!0,italic:!0},(typeof q.content==="string"&&q.content.length>${MAX}?q.content.slice(0,${MAX})+"\\u2026[truncated "+(q.content.length-${MAX})+" chars]":q.content))`;
    const result3 = result2.split(anchor3).join(patched3);
    if (result3 !== result2) {
      ccpLog('  [large-content-guard] raw away_summary italic branch protected (max ' + MAX + ' chars)');
    }
    return result3;
  },
};

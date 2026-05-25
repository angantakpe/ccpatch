export default {
  category: 'fix',

  description: 'Truncate oversized system-message content before lZ7 renders it, preventing terminal crash',
  capabilities: ["prompt"],
  verify: {
    present: ['chars truncated'],
  },
  apply: (code) => {
    // The lZ7 system-message renderer can crash on extremely large content
    // (100KB+ from tool results or hook output) — Ink's text-measurement/layout
    // chokes. This patch wraps two render paths with a truncation IIFE.

    const MAX = 50_000;
    let result = code;

    // First anchor: guard the general content rendering path (lZ7 line ~5514).
    // The component name has rotated across versions (ah_ → ox_ → A45) but the
    // props destructure shape `{content:Y,addMargin:K,dot:f,color:O,dimColor:M}`
    // is stable. Match the call-site by capturing the component identifier.
    const callRe = /([A-Za-z_$][\w$]*),\{content:Y,addMargin:K,dot:f,color:O,dimColor:M\}/;
    const callMatch = result.match(callRe);
    let result2 = result;
    if (callMatch) {
      const COMP = callMatch[1];
      const anchor2 = `${COMP},{content:Y,addMargin:K,dot:f,color:O,dimColor:M}`;
      const patched2 = `${COMP},{content:(typeof Y==="string"&&Y.length>${MAX}?Y.slice(0,${MAX})+"\\u2026[truncated "+(Y.length-${MAX})+" chars]":Y),addMargin:K,dot:f,color:O,dimColor:M}`;
      result2 = result.split(anchor2).join(patched2);
      console.log(`  [large-content-guard] ${COMP} general content path protected (max ${MAX} chars)`);
    } else {
      console.warn('  [!] large-content-guard: general content anchor not found — content path unprotected');
    }

    // Second anchor: raw bundle — away_summary content rendered as italic text block
    // Stable across versions: the structural createElement pattern for recap content display
    const anchor3 = 'N6.createElement(k,{dimColor:!0,italic:!0},q.content)';
    const patched3 = `N6.createElement(k,{dimColor:!0,italic:!0},(typeof q.content==="string"&&q.content.length>${MAX}?q.content.slice(0,${MAX})+"\\u2026[truncated "+(q.content.length-${MAX})+" chars]":q.content))`;
    const result3 = result2.split(anchor3).join(patched3);
    if (result3 !== result2) {
      console.log('  [large-content-guard] raw away_summary italic branch protected (max ' + MAX + ' chars)');
    }
    return result3;
  },
};

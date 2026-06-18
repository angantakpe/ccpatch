import { ccpLog } from '../runner/cli/style.mjs';

export default {
    category: 'observe',

    description: 'Boost loadedFrom:"commands_DEPRECATED" items to top of slash-command autocomplete',
    capabilities: ["tools"],
    verify: {
      present: '_ip=(s)=>s.loadedFrom==="commands_DEPRECATED"',
      label: 'Boost Project Commands',
      // apply() rewrites two sort expressions (sort A + sort B), each injecting
      // the _ip helper once → exactly 2 occurrences after a correct apply.
      count: { present: 2 },
    },
    apply: (code) => {
      // Two sort expressions gated by whether a search string is active:
      //   Sort A (search active, score-based)
      //   Sort B (no search, source-alphabetical)
      //
      // Bug in a prior version: boosted source==="projectSettings" alongside
      // commands_DEPRECATED. Local skills also carry that source and have large
      // recency timestamps, burying commands (which have timestamp 0, never
      // used). Fix: only boost loadedFrom==="commands_DEPRECATED".
      //
      // The two sort expressions are structurally fixed but every identifier in
      // them (collection var, sort params, the recency Map var, the label
      // helper fn) is a minified name that rotates each release — historically
      // this patch carried a hand-maintained list of ~11 literal variants
      // (v2.1.112 … v2.1.156). Per rule #1 those are now regex-captured instead,
      // so a single matcher generalises every past and future variant:
      //
      //   Sort A: return <COLL>.sort((<a>,<b>)=>(<map>.get(<b>)??0)-(<map>.get(<a>)??0)
      //             ||<fn>(<a>).localeCompare(<fn>(<b>)))
      //   Sort B: return <COLL>.sort((<c>,<d>)=>String(<c>.source).localeCompare(String(<d>.source))
      //             ||<fn>(<c>).localeCompare(<fn>(<d>)))
      const sortARe =
        /return ([A-Za-z_$][\w$]*)\.sort\(\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)=>\(([A-Za-z_$][\w$]*)\.get\(\3\)\?\?0\)-\(\4\.get\(\2\)\?\?0\)\|\|([A-Za-z_$][\w$]*)\(\2\)\.localeCompare\(\5\(\3\)\)\)/;
      const sortBRe =
        /return ([A-Za-z_$][\w$]*)\.sort\(\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)=>String\(\2\.source\)\.localeCompare\(String\(\3\.source\)\)\|\|([A-Za-z_$][\w$]*)\(\2\)\.localeCompare\(\4\(\3\)\)\)/;

      const IP = `const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";`;
      if (code.includes(IP)) return code; // idempotent — already patched

      const a = code.match(sortARe);
      const b = code.match(sortBRe);
      if (!a || !b) {
        console.warn('  [!] boost_project_commands: sort markers not found — patch skipped');
        return code;
      }

      const [, collA, pA, pB, mapV, fnA] = a;
      const sortANew =
        `return ${collA}.sort((${pA},${pB})=>{${IP}const _pA=_ip(${pA}),_pB=_ip(${pB});if(_pA!==_pB)return _pA?-1:1;return(${mapV}.get(${pB})??0)-(${mapV}.get(${pA})??0)||${fnA}(${pA}).localeCompare(${fnA}(${pB}))})`;

      const [, collB, pC, pD, fnB] = b;
      const sortBNew =
        `return ${collB}.sort((${pC},${pD})=>{${IP}const _aC=_ip(${pC})?0:1,_aD=_ip(${pD})?0:1;if(_aC!==_aD)return _aC-_aD;return String(${pC}.source).localeCompare(String(${pD}.source))||${fnB}(${pC}).localeCompare(${fnB}(${pD}))})`;

      code = code.replace(sortARe, sortANew).replace(sortBRe, sortBNew);
      ccpLog('  [boost_project_commands] patched sort A + sort B');
      return code;
    }
  };

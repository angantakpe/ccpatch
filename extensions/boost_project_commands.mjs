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
      // Bug in prior version: boosted source==="projectSettings" alongside commands_DEPRECATED.
      // Local skills also carry that source and have large recency timestamps, burying commands
      // (which have timestamp 0, never used). Fix: only boost loadedFrom==="commands_DEPRECATED".
      //
      // Variants: v2.1.112 uses (C,x)/y_  |  v2.1.114 uses (I,u)/C1 and (h,I)/C1

      const variants = [
        {
          sortA: `return R.sort((C,x)=>(h.get(x)??0)-(h.get(C)??0)||y_(C).localeCompare(y_(x)))`,
          sortB: `return R.sort((h,C)=>String(h.source).localeCompare(String(C.source))||y_(h).localeCompare(y_(C)))`,
          sortANew: `return R.sort((C,x)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pC=_ip(C),_pX=_ip(x);if(_pC!==_pX)return _pC?-1:1;return(h.get(x)??0)-(h.get(C)??0)||y_(C).localeCompare(y_(x))})`,
          sortBNew: `return R.sort((h,C)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _ah=_ip(h)?0:1,_aC=_ip(C)?0:1;if(_ah!==_aC)return _ah-_aC;return String(h.source).localeCompare(String(C.source))||y_(h).localeCompare(y_(C))})`,
        },
        {
          sortA: `return R.sort((I,u)=>(h.get(u)??0)-(h.get(I)??0)||C1(I).localeCompare(C1(u)))`,
          sortB: `return R.sort((h,I)=>String(h.source).localeCompare(String(I.source))||C1(h).localeCompare(C1(I)))`,
          sortANew: `return R.sort((I,u)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pI=_ip(I),_pU=_ip(u);if(_pI!==_pU)return _pI?-1:1;return(h.get(u)??0)-(h.get(I)??0)||C1(I).localeCompare(C1(u))})`,
          sortBNew: `return R.sort((h,I)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _ah=_ip(h)?0:1,_aI=_ip(I)?0:1;if(_ah!==_aI)return _ah-_aI;return String(h.source).localeCompare(String(I.source))||C1(h).localeCompare(C1(I))})`,
        },
        {
          // v2.1.123: Q/(l,o)/y_, c.get, then Q/(c,l)/y_
          sortA: `return Q.sort((l,o)=>(c.get(o)??0)-(c.get(l)??0)||y_(l).localeCompare(y_(o)))`,
          sortB: `return Q.sort((c,l)=>String(c.source).localeCompare(String(l.source))||y_(c).localeCompare(y_(l)))`,
          sortANew: `return Q.sort((l,o)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pL=_ip(l),_pO=_ip(o);if(_pL!==_pO)return _pL?-1:1;return(c.get(o)??0)-(c.get(l)??0)||y_(l).localeCompare(y_(o))})`,
          sortBNew: `return Q.sort((c,l)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aC=_ip(c)?0:1,_aL=_ip(l)?0:1;if(_aC!==_aL)return _aC-_aL;return String(c.source).localeCompare(String(l.source))||y_(c).localeCompare(y_(l))})`,
        },
        {
          // v2.1.126: Q/(l,a)/E_, c.get, then Q/(c,l)/E_
          sortA: `return Q.sort((l,a)=>(c.get(a)??0)-(c.get(l)??0)||E_(l).localeCompare(E_(a)))`,
          sortB: `return Q.sort((c,l)=>String(c.source).localeCompare(String(l.source))||E_(c).localeCompare(E_(l)))`,
          sortANew: `return Q.sort((l,a)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pL=_ip(l),_pA=_ip(a);if(_pL!==_pA)return _pL?-1:1;return(c.get(a)??0)-(c.get(l)??0)||E_(l).localeCompare(E_(a))})`,
          sortBNew: `return Q.sort((c,l)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aC=_ip(c)?0:1,_aL=_ip(l)?0:1;if(_aC!==_aL)return _aC-_aL;return String(c.source).localeCompare(String(l.source))||E_(c).localeCompare(E_(l))})`,
        },
        {
          // v2.1.128: Q/(l,a)/x_, c.get, then Q/(c,l)/x_
          sortA: `return Q.sort((l,a)=>(c.get(a)??0)-(c.get(l)??0)||x_(l).localeCompare(x_(a)))`,
          sortB: `return Q.sort((c,l)=>String(c.source).localeCompare(String(l.source))||x_(c).localeCompare(x_(l)))`,
          sortANew: `return Q.sort((l,a)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pL=_ip(l),_pA=_ip(a);if(_pL!==_pA)return _pL?-1:1;return(c.get(a)??0)-(c.get(l)??0)||x_(l).localeCompare(x_(a))})`,
          sortBNew: `return Q.sort((c,l)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aC=_ip(c)?0:1,_aL=_ip(l)?0:1;if(_aC!==_aL)return _aC-_aL;return String(c.source).localeCompare(String(l.source))||x_(c).localeCompare(x_(l))})`,
        },
        {
          // v2.1.131: Q/(l,a)/m_, c.get, then Q/(c,l)/m_
          sortA: `return Q.sort((l,a)=>(c.get(a)??0)-(c.get(l)??0)||m_(l).localeCompare(m_(a)))`,
          sortB: `return Q.sort((c,l)=>String(c.source).localeCompare(String(l.source))||m_(c).localeCompare(m_(l)))`,
          sortANew: `return Q.sort((l,a)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pL=_ip(l),_pA=_ip(a);if(_pL!==_pA)return _pL?-1:1;return(c.get(a)??0)-(c.get(l)??0)||m_(l).localeCompare(m_(a))})`,
          sortBNew: `return Q.sort((c,l)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aC=_ip(c)?0:1,_aL=_ip(l)?0:1;if(_aC!==_aL)return _aC-_aL;return String(c.source).localeCompare(String(l.source))||m_(c).localeCompare(m_(l))})`,
        },
        {
          // v2.1.132: Q/(l,t)/U_, c.get, then Q/(c,l)/U_
          sortA: `return Q.sort((l,t)=>(c.get(t)??0)-(c.get(l)??0)||U_(l).localeCompare(U_(t)))`,
          sortB: `return Q.sort((c,l)=>String(c.source).localeCompare(String(l.source))||U_(c).localeCompare(U_(l)))`,
          sortANew: `return Q.sort((l,t)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pL=_ip(l),_pT=_ip(t);if(_pL!==_pT)return _pL?-1:1;return(c.get(t)??0)-(c.get(l)??0)||U_(l).localeCompare(U_(t))})`,
          sortBNew: `return Q.sort((c,l)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aC=_ip(c)?0:1,_aL=_ip(l)?0:1;if(_aC!==_aL)return _aC-_aL;return String(c.source).localeCompare(String(l.source))||U_(c).localeCompare(U_(l))})`,
        },
        {
          // v2.1.138: Q/(c,s)/g_, l.get, then Q/(l,c)/g_
          sortA: `return Q.sort((c,s)=>(l.get(s)??0)-(l.get(c)??0)||g_(c).localeCompare(g_(s)))`,
          sortB: `return Q.sort((l,c)=>String(l.source).localeCompare(String(c.source))||g_(l).localeCompare(g_(c)))`,
          sortANew: `return Q.sort((c,s)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pC=_ip(c),_pS=_ip(s);if(_pC!==_pS)return _pC?-1:1;return(l.get(s)??0)-(l.get(c)??0)||g_(c).localeCompare(g_(s))})`,
          sortBNew: `return Q.sort((l,c)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aL=_ip(l)?0:1,_aC=_ip(c)?0:1;if(_aL!==_aC)return _aL-_aC;return String(l.source).localeCompare(String(c.source))||g_(l).localeCompare(g_(c))})`,
        },
        {
          // v2.1.146: l/(i,e)/a_, d.get, then l/(d,i)/a_
          sortA: `return l.sort((i,e)=>(d.get(e)??0)-(d.get(i)??0)||a_(i).localeCompare(a_(e)))`,
          sortB: `return l.sort((d,i)=>String(d.source).localeCompare(String(i.source))||a_(d).localeCompare(a_(i)))`,
          sortANew: `return l.sort((i,e)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pI=_ip(i),_pE=_ip(e);if(_pI!==_pE)return _pI?-1:1;return(d.get(e)??0)-(d.get(i)??0)||a_(i).localeCompare(a_(e))})`,
          sortBNew: `return l.sort((d,i)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aD=_ip(d)?0:1,_aI=_ip(i)?0:1;if(_aD!==_aI)return _aD-_aI;return String(d.source).localeCompare(String(i.source))||a_(d).localeCompare(a_(i))})`,
        },
        {
          // v2.1.150: l/(r,t)/A_, d.get, then l/(d,r)/A_
          sortA: `return l.sort((r,t)=>(d.get(t)??0)-(d.get(r)??0)||A_(r).localeCompare(A_(t)))`,
          sortB: `return l.sort((d,r)=>String(d.source).localeCompare(String(r.source))||A_(d).localeCompare(A_(r)))`,
          sortANew: `return l.sort((r,t)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pR=_ip(r),_pT=_ip(t);if(_pR!==_pT)return _pR?-1:1;return(d.get(t)??0)-(d.get(r)??0)||A_(r).localeCompare(A_(t))})`,
          sortBNew: `return l.sort((d,r)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aD=_ip(d)?0:1,_aR=_ip(r)?0:1;if(_aD!==_aR)return _aD-_aR;return String(d.source).localeCompare(String(r.source))||A_(d).localeCompare(A_(r))})`,
        },
        {
          // v2.1.156: l/(r,a)/O_, c.get, then l/(c,r)/O_
          sortA: `return l.sort((r,a)=>(c.get(a)??0)-(c.get(r)??0)||O_(r).localeCompare(O_(a)))`,
          sortB: `return l.sort((c,r)=>String(c.source).localeCompare(String(r.source))||O_(c).localeCompare(O_(r)))`,
          sortANew: `return l.sort((r,a)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _pR=_ip(r),_pA=_ip(a);if(_pR!==_pA)return _pR?-1:1;return(c.get(a)??0)-(c.get(r)??0)||O_(r).localeCompare(O_(a))})`,
          sortBNew: `return l.sort((c,r)=>{const _ip=(s)=>s.loadedFrom==="commands_DEPRECATED";const _aC=_ip(c)?0:1,_aR=_ip(r)?0:1;if(_aC!==_aR)return _aC-_aR;return String(c.source).localeCompare(String(r.source))||O_(c).localeCompare(O_(r))})`,
        },
      ];

      for (const { sortA, sortB, sortANew, sortBNew } of variants) {
        if (code.includes(sortA) && code.includes(sortB)) {
          code = code.split(sortA).join(sortANew);
          code = code.split(sortB).join(sortBNew);
          ccpLog('  [boost_project_commands] patched sort A + sort B');
          return code;
        }
      }
      console.warn('  [!] boost_project_commands: sort markers not found — patch skipped');
      return code;
    }
  };

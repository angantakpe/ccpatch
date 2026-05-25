
export default {
    category: 'fix',

    description: 'Fix projectRoot getter to fall back to originalCwd, so commands loader finds .cc/commands/',
    capabilities: ["env","fs"],
    // verify.absent lists every pre-patch marker; after apply(), the one that
    // matched has been rewritten and the rest were never present — so none
    // should remain. For the v2.1.146+ nullish-coalescing variant, the regex
    // match is replaced wholesale.
    verify: {
      absent: [
        'function c9(){return B8.projectRoot}',
        'function l9(){return m$.projectRoot}',
        'function O_(){return F$.projectRoot}',
        'function e1(){return Q$.projectRoot}',
        'function R1(){return d$.projectRoot}',
        'function I1(){return c$.projectRoot}',
        'function m1(){return d$.projectRoot}',
        'function g1(){return Q$.projectRoot}',
      ],
    },
    apply: (code) => {
      // v2.1.112: c9()/B8  |  v2.1.114: l9()/m$
      const variants = [
        ['function c9(){return B8.projectRoot}', 'function c9(){return B8.projectRoot||B8.originalCwd}'],
        ['function l9(){return m$.projectRoot}',  'function l9(){return m$.projectRoot||m$.originalCwd}'],
        ['function O_(){return F$.projectRoot}',  'function O_(){return F$.projectRoot||F$.originalCwd}'],
        // v2.1.126
        ['function e1(){return Q$.projectRoot}',  'function e1(){return Q$.projectRoot||Q$.originalCwd}'],
        // v2.1.128
        ['function R1(){return d$.projectRoot}',  'function R1(){return d$.projectRoot||d$.originalCwd}'],
        // v2.1.131
        ['function I1(){return c$.projectRoot}',  'function I1(){return c$.projectRoot||c$.originalCwd}'],
        // v2.1.132
        ['function m1(){return d$.projectRoot}',  'function m1(){return d$.projectRoot||d$.originalCwd}'],
        // v2.1.138
        ['function g1(){return Q$.projectRoot}',  'function g1(){return Q$.projectRoot||Q$.originalCwd}'],
      ];
      for (const [marker, replacement] of variants) {
        if (code.includes(marker)) {
          console.log(`  [fix_project_root] patched ${marker.slice(9,11)}() to fall back to originalCwd`);
          return code.split(marker).join(replacement);
        }
      }
      // v2.1.146+: shape changed to nullish-coalescing layer through a session
      // accessor — `function X(){return Y()?.projectRoot??Z.projectRoot}`. Append
      // `??Z.originalCwd` as the final fallback so the .cc/commands/ loader still
      // resolves when both layers are unset.
      const re = /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*\(\)\?\.projectRoot\?\?)([A-Za-z_$][\w$]*)\.projectRoot\}/;
      const m = code.match(re);
      if (m) {
        const [whole, fnName, prefix, varName] = m;
        const replacement = `function ${fnName}(){return ${prefix}${varName}.projectRoot??${varName}.originalCwd}`;
        console.log(`  [fix_project_root] patched ${fnName}() to fall back to originalCwd (nullish-coalescing variant)`);
        return code.replace(whole, replacement);
      }
      console.warn('  [!] fix_project_root: marker not found — patch skipped');
      return code;
    }
  };

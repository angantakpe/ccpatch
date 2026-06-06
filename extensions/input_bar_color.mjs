import { ccpLog } from '../runner/cli/style.mjs';

export default {
    description: 'Color the prompt input bar border green',
    capabilities: [],
    verify: {
      present: 'promptBorder:"ansi:green"',
      // Every white promptBorder must have been rewritten — pre-patch value gone.
      absent: 'promptBorder:"ansi:white"',
      label: 'Input Bar Color',
    },
    apply: (code) => {
      // Replace promptBorder theme values (ansi:white and rgb grays) with green
      // across all theme variants (light/dark/ansi/rgb)
      let count = 0;

      code = code.replace(/promptBorder:"ansi:white"/g, () => { count++; return 'promptBorder:"ansi:green"'; });
      code = code.replace(/promptBorder:"rgb\(\d+,\d+,\d+\)"/g, () => { count++; return 'promptBorder:"ansi:green"'; });

      if (count === 0) {
        console.warn('  [!] input_bar_color: could not find promptBorder theme entries');
      } else {
        ccpLog('  [input_bar_color] patched ' + count + ' promptBorder theme values → ansi:green');
      }
      return code;
    }
  };

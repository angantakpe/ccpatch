// Converted to kind: 'prefix' — the patch's behavior is "inject an env-var
// short-circuit at the entry of the alwaysThinkingEnabled() function". The
// stable string literal MAX_THINKING_TOKENS uniquely anchors that function in
// the minified bundle.
export default {
  category: 'feature',
  description: 'Force thinking enabled when CC_THINKING env var is set (interactive sessions)',
  capabilities: ['prompt', 'env'],
  verify: { present: 'CC_THINKING!=="disabled"', weak: true },

  kind: 'prefix',
  // Anchor: process.env.MAX_THINKING_TOKENS is a property access, not a quoted
  // string literal — use body-substring matching to find the enclosing fn.
  target: { function: { body: 'process.env.MAX_THINKING_TOKENS' } },
  code: 'if(process.env.CC_THINKING&&process.env.CC_THINKING!=="disabled"&&process.env.CC_THINKING!=="0")return!0;',
};

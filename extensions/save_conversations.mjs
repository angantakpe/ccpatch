
export default {
    category: 'optional',
    enabled: false,

    description: 'Auto-save all conversations to JSON file',
    capabilities: ["network","fs","env","telemetry"],
    verify: { present: "'save_conversations'", count: { present: 1 } },
  dependsOn: ['fetch_interceptor'],
  allowOverlapWith: ['session_timer'],
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Conversation Saver
// ══════════════════════════════════════════════════════════════════════════
(async () => {
  const { appendFileSync, mkdirSync: _mkdirSync, writeFileSync: _writeFileSync, existsSync: _existsSync } = await import('fs');
  const { join: _join, resolve: _resolve, sep: _sep } = await import('path');

  // Conversation transcripts are sensitive (full user/assistant text), so the
  // dir+files are owner-only (0700 dir / 0600 files) — matching cache_responses.
  // CC_PROJECT_ROOT is attacker-influenced (dotenv_loader now denies it from a
  // repo-local .env, but a shell value or other caller could still point it
  // elsewhere), so resolve the target and reject any path that escapes the
  // expected project root via traversal.
  const _projectRoot = _resolve(process.env.CC_PROJECT_ROOT || process.cwd());
  const CONVO_DIR = _resolve(_projectRoot, 'storage', 'conversations');
  // Defence in depth: the resolved transcript dir must stay strictly under
  // <projectRoot>/ (a malicious CC_PROJECT_ROOT or unexpected join result that
  // points elsewhere is rejected rather than silently writing off-tree).
  const _rootPrefix = _projectRoot.endsWith(_sep) ? _projectRoot : _projectRoot + _sep;
  if (!(CONVO_DIR + _sep).startsWith(_rootPrefix)) {
    console.error('[ccpatch] save_conversations: refusing to write outside project root (path traversal via CC_PROJECT_ROOT?) — disabled');
    return;
  }
  try { _mkdirSync(CONVO_DIR, { recursive: true, mode: 0o700 }); } catch {}

  const sessionId = Date.now().toString(36);
  const convoFile = _join(CONVO_DIR, \`session-\${sessionId}.jsonl\`);
  // Create the transcript file 0600 up front so appends never land in a
  // world/group-readable file (appendFileSync's mode only applies on create).
  try { if (!_existsSync(convoFile)) _writeFileSync(convoFile, '', { mode: 0o600 }); } catch {}

  globalThis.__saveMessage__ = (role, content) => {
    const entry = { ts: new Date().toISOString(), role, content: content?.slice?.(0, 5000) || content };
    appendFileSync(convoFile, JSON.stringify(entry) + '\\n', { mode: 0o600 });
  };
  
  // Conversation logging enabled (silent - check ~/.cc/conversations/)

  if (globalThis.__ccpOnFetch) {
    // Use shared fetch interceptor — no direct tee() call here
    globalThis.__ccpOnFetch('save_conversations', ({ url, options, isApi, events }) => {
      if (!isApi || !events) return;

      // Capture outgoing user message from request body
      try {
        const body = JSON.parse(options?.body);
        const msgs = body.messages || [];
        const last = msgs[msgs.length - 1];
        if (last?.role === 'user') {
          const content = typeof last.content === 'string' ? last.content
            : (last.content || []).map(c => c.text || '').join('');
          globalThis.__saveMessage__?.('user', content);
        }
      } catch(e) {}

      // Capture assistant response from pre-parsed SSE events
      let buf = '';
      for (const ev of events) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') buf += ev.delta.text;
        if (ev.type === 'message_stop' && buf) { globalThis.__saveMessage__?.('assistant', buf); buf = ''; }
      }
    });
  } else {
    // Fallback: direct fetch wrapper if fetch_interceptor patch is not active
    const __convOrigFetch__ = globalThis.fetch;
    globalThis.fetch = async function convFetch(url, options) {
      const urlStr = String(url?.url || url || '');
      const isMessages = urlStr.includes('/v1/messages') && options?.method === 'POST';
      if (isMessages) {
        try {
          const body = JSON.parse(options.body);
          const msgs = body.messages || [];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'user') {
            const content = typeof last.content === 'string' ? last.content
              : (last.content || []).map(c => c.text || '').join('');
            globalThis.__saveMessage__?.('user', content);
          }
        } catch(e) {}
      }
      const resp = await __convOrigFetch__.apply(this, arguments);
      if (!isMessages || !resp.ok || !resp.body) return resp;
      const tee = resp.body.tee();
      const reader = tee[1].getReader();
      const dec = new TextDecoder();
      (async () => {
        try {
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of dec.decode(value, { stream: true }).split('\\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') buf += ev.delta.text;
                if (ev.type === 'message_stop' && buf) { globalThis.__saveMessage__?.('assistant', buf); buf = ''; }
              } catch(e) {}
            }
          }
        } catch(e) {}
      })();
      return new Response(tee[0], { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    };
  }
})();
`;
          const _CJS_IIFE = '(function(exports, require, module, __filename, __dirname) {';
    // Idempotency guard (rule 2): the hook embeds this unique banner; if it's
    // already present the bundle is patched — return unchanged.
    if (code.includes('[PATCH] Conversation Saver')) return code;
    if (code.startsWith('#!/usr/bin/env node')) {
      return code.replace('#!/usr/bin/env node', '#!/usr/bin/env node' + hook);
    } else if (code.includes(_CJS_IIFE)) {
      return code.replace(_CJS_IIFE, () => _CJS_IIFE + hook);
    } else {
      console.warn('  [!] anchor not found (no shebang, no CJS-IIFE) — skipping');
      return code;
    }
    }
  };

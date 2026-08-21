/**
 * telegram — channel adapter wiring Telegram bot DMs to a ccpatch
 * headless_bridge session via BridgeClient.
 *
 * The Telegram Bot API transport (long polling, update parsing, replies) is
 * NOT reimplemented here — it's delegated to grammy (https://grammy.dev,
 * MIT), the same library OpenClaw's own Telegram channel is built on
 * (workspace/projects/openclaw/extensions/telegram). This adapter owns only
 * the translation layer: Telegram message in -> bridge.submit() -> bridge
 * result/events -> Telegram reply out.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN          required — issued by @BotFather.
 *   TELEGRAM_ALLOWED_CHAT_IDS   comma-separated chat id allowlist. Same
 *                                default-deny posture as headless_bridge's own
 *                                CC_BRIDGE_TOOL_ALLOWLIST:
 *                                  unset/empty -> every chat denied (loud
 *                                    one-time startup warning)
 *                                  '*'         -> allow every chat (explicit
 *                                    opt-in, not the default)
 *                                  '123,456'   -> only those chat ids
 *
 * grammy is an optionalDependency of this package — only required if you
 * actually start the telegram adapter. `npm install` it before running.
 *
 * ── Ordering and isolation: what this does and does NOT give you ────────────
 *
 * Two separate queues sit between Telegram and the bridge, and they solve two
 * different problems. Neither of them is session isolation.
 *
 *   * Per-chat (`chatTurns`, keyed by chat id) — two messages from the SAME
 *     chat are handled strictly in arrival order. Without it, a user firing
 *     two messages in quick succession would get two placeholders racing each
 *     other's edits.
 *   * Gateway-wide (`bridgeTurns` in ../streaming.mjs) — at most one submit is
 *     in flight across ALL chats, because `headless_bridge` does not correlate
 *     event frames to the submit that caused them (see that module's header
 *     for the three-link evidence chain). Mid-turn `assistant.text` is only
 *     attributable to a turn if exactly one turn is running.
 *
 * !! ALL CHATS SHARE ONE UNDERLYING CLAUDE CODE CONVERSATION !!
 *
 * One gateway process holds ONE bridge connection to ONE patched CLI session,
 * so every chat submits into the same turn history: chat B can read what chat
 * A said, and both mutate the same context. The queues above prevent *reply*
 * races; they do not give any chat a private conversation. Real multi-tenancy
 * (one patched CLI process + one bridge socket per user, routed by chat id) is
 * NOT implemented — treat TELEGRAM_ALLOWED_CHAT_IDS as a list of people you
 * would be comfortable sharing one terminal with.
 */
import { streamTurn, SerialQueue, DEFAULT_EDIT_THROTTLE_MS } from '../streaming.mjs';

/**
 * Wrap a grammy context as the abstract message surface streamTurn edits: one
 * placeholder message per turn, mutated in place as text arrives.
 * @param {any} ctx grammy context (needs ctx.chat.id, ctx.reply, ctx.api.editMessageText)
 */
export function createMessageSurface(ctx) {
  let messageId = null;
  return {
    async send(text) {
      const sent = await ctx.reply(text);
      messageId = sent && sent.message_id;
      return sent;
    },
    async edit(text) {
      if (messageId == null) return;
      return ctx.api.editMessageText(ctx.chat.id, messageId, text);
    },
  };
}

const parseAllowlist = (raw) => {
  const entries = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { allowAll: entries.includes('*'), allowSet: new Set(entries.filter((s) => s !== '*')) };
};

/**
 * The `message:text` handler, built independently of grammy's `Bot` so it can
 * be unit-tested against a fake ctx.
 *
 * @param {object} o
 * @param {{ on: Function, off: Function, submit: (p: string) => Promise<any> }} o.bridge
 * @param {(chatId: any) => boolean} o.isAllowed
 * @param {SerialQueue} o.chatTurns
 * @param {(msg: string) => void} [o.log]
 * @param {number} [o.editThrottleMs]
 */
export function createMessageHandler({ bridge, isAllowed, chatTurns, log = console.log, editThrottleMs = DEFAULT_EDIT_THROTTLE_MS }) {
  return async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAllowed(chatId)) {
      log(`[telegram] denied chat ${chatId} (not in TELEGRAM_ALLOWED_CHAT_IDS)`);
      return;
    }
    // Per-chat FIFO: a second message from this chat waits for this one, so the
    // two turns never interleave their placeholder edits.
    return chatTurns.run(chatId, async () => {
      try {
        await streamTurn({
          bridge,
          prompt: ctx.message.text,
          message: createMessageSurface(ctx),
          throttleMs: editThrottleMs,
          log: (msg) => log(`[telegram] chat ${chatId}: ${msg}`),
        });
      } catch (e) {
        // streamTurn already edits the placeholder to show submit errors; this
        // only catches a failure of the Telegram calls themselves.
        log(`[telegram] chat ${chatId} turn failed: ${e.message}`);
        await ctx.reply(`error: ${e.message}`).catch(() => {});
      }
    });
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.token]
 * @param {string} [opts.allowedChatIds]
 * @param {number} [opts.editThrottleMs] mid-turn edit interval (Telegram rate-limits edits)
 * @returns {import('../adapter.mjs').ChannelAdapter}
 */
export function createTelegramAdapter({
  token = process.env.TELEGRAM_BOT_TOKEN,
  allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS,
  editThrottleMs = DEFAULT_EDIT_THROTTLE_MS,
} = {}) {
  if (!token) throw new Error('telegram adapter: TELEGRAM_BOT_TOKEN (or opts.token) is required');

  const { allowAll, allowSet } = parseAllowlist(allowedChatIds);
  const isAllowed = (chatId) => allowAll || allowSet.has(String(chatId));

  /** Per-chat ordering; the gateway-wide submit lock lives in ../streaming.mjs. */
  const chatTurns = new SerialQueue();

  /** @type {import('grammy').Bot | null} */
  let bot = null;

  return {
    name: 'telegram',

    async start({ bridge, log = console.log }) {
      if (allowedChatIds == null) {
        log('[telegram] TELEGRAM_ALLOWED_CHAT_IDS is unset — every chat is DENIED by default. ' +
          'Set it to a comma-separated chat id list, or "*" to allow all.');
      }

      let Bot;
      try {
        ({ Bot } = await import('grammy'));
      } catch (e) {
        throw new Error(
          'telegram adapter: grammy is not installed. Run `npm install` inside packages/gateway ' +
          `(grammy is an optionalDependency). Original error: ${e.message}`
        );
      }

      bot = new Bot(token);

      bot.on('message:text', createMessageHandler({ bridge, isAllowed, chatTurns, log, editThrottleMs }));

      bot.catch((err) => log(`[telegram] bot error: ${err.message}`));

      await bot.start({ onStart: () => log('[telegram] long-polling started') });
    },

    async stop() {
      if (bot) await bot.stop();
      bot = null;
    },
  };
}

export default createTelegramAdapter;

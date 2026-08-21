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
 */

const parseAllowlist = (raw) => {
  const entries = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { allowAll: entries.includes('*'), allowSet: new Set(entries.filter((s) => s !== '*')) };
};

/**
 * @param {object} [opts]
 * @param {string} [opts.token]
 * @param {string} [opts.allowedChatIds]
 * @returns {import('../adapter.mjs').ChannelAdapter}
 */
export function createTelegramAdapter({
  token = process.env.TELEGRAM_BOT_TOKEN,
  allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS,
} = {}) {
  if (!token) throw new Error('telegram adapter: TELEGRAM_BOT_TOKEN (or opts.token) is required');

  const { allowAll, allowSet } = parseAllowlist(allowedChatIds);
  const isAllowed = (chatId) => allowAll || allowSet.has(String(chatId));

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

      bot.on('message:text', async (ctx) => {
        const chatId = ctx.chat.id;
        if (!isAllowed(chatId)) {
          log(`[telegram] denied chat ${chatId} (not in TELEGRAM_ALLOWED_CHAT_IDS)`);
          return;
        }
        try {
          const result = await bridge.submit(ctx.message.text);
          const text = (result && (result.final ?? result.text)) ?? JSON.stringify(result ?? null);
          await ctx.reply(String(text));
        } catch (e) {
          log(`[telegram] submit failed for chat ${chatId}: ${e.message}`);
          await ctx.reply(`error: ${e.message}`).catch(() => {});
        }
      });

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

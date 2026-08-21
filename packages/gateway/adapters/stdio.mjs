/**
 * stdio — zero-dependency channel adapter that turns the local terminal into
 * a channel: one line of stdin = one bridge.submit(), the turn's final result
 * printed to stdout.
 *
 * This is the "does my bridge actually work" adapter. Unlike adapters/telegram.mjs
 * it needs no npm package, no bot token, and no network — only node:readline —
 * so it doubles as the reference implementation of the ChannelAdapter contract
 * (see ../adapter.mjs).
 *
 * Usage, interactive:
 *   CC_BRIDGE_ADDR=unix:/run/ccpatch.sock CC_BRIDGE_TOKEN=… \
 *   GATEWAY_ADAPTERS=stdio node run.mjs
 *
 * Usage, piped (one submit, then a clean exit at EOF):
 *   echo 'summarize the repo' | GATEWAY_ADAPTERS=stdio node run.mjs
 *
 * Only turn results go to stdout, so piped output stays machine-readable. The
 * startup banner and the interactive `> ` prompt go straight to stderr;
 * failures go through the adapter-scoped `log`, same as telegram.mjs.
 *
 * Lines are processed strictly one at a time — the next line is not read until
 * the previous submit settles, since the bridge runs one turn at a time.
 *
 * The "final result" is the accumulated `assistant.text` stream, not
 * `bridge.submit()`'s return value — confirmed live against a real patched
 * CLI on 2026-08-21 that submit() resolves with nothing usable (see
 * streaming.mjs's `resolveTurnText` header for why). `submitAndCollect`
 * (../streaming.mjs) does that accumulation and also holds the same
 * gateway-wide submit lock `streamTurn` uses, so a submit from this adapter
 * and a concurrent submit from telegram.mjs (if both are running against the
 * same bridge) still can't have their assistant.text interleave.
 */
import readline from 'node:readline';
import { submitAndCollect } from '../streaming.mjs';

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onEnd] - called once stdin hits EOF and the last
 *   submit has settled. Default: raise SIGINT on ourselves so run.mjs's normal
 *   shutdown path (stop every adapter, close the bridge) runs instead of the
 *   process hanging on the still-open bridge socket.
 * @param {NodeJS.WritableStream} [opts.banner] - where the banner/prompt go.
 * @returns {import('../adapter.mjs').ChannelAdapter}
 */
export function createStdioAdapter({
  onEnd = () => process.kill(process.pid, 'SIGINT'),
  banner = process.stderr,
} = {}) {
  /** @type {readline.Interface | null} */
  let rl = null;
  /** @type {NodeJS.ReadableStream | null} */
  let source = null;
  /** @type {Promise<void> | null} */
  let loop = null;
  let stopping = false;

  return {
    name: 'stdio',

    /**
     * @param {import('../adapter.mjs').GatewayContext & {
     *   input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream
     * }} ctx - `input`/`output` are injectable so the adapter is testable
     *   without a TTY; they default to this process's stdin/stdout.
     */
    start({ bridge, log = console.error, input = process.stdin, output = process.stdout }) {
      stopping = false;
      source = input;
      rl = readline.createInterface({ input, crlfDelay: Infinity });

      const prompt = () => { if (input.isTTY) banner.write('> '); };
      banner.write('[stdio] reading prompts from stdin — one line per turn, Ctrl-D to exit\n');
      prompt();

      loop = (async () => {
        for await (const raw of rl) {
          const line = raw.trim();
          if (!line) { prompt(); continue; }
          const { ok, text } = await submitAndCollect({ bridge, prompt: line });
          if (ok) output.write(`${text}\n`);
          else log(`[stdio] submit failed: ${text}`);
          prompt();
        }
      })();

      loop.then(
        () => { if (!stopping) onEnd(); },
        (e) => log(`[stdio] input loop failed: ${e.message}`)
      );
    },

    async stop() {
      stopping = true;
      if (rl) rl.close();
      // readline leaves the input stream resumed; without this the process
      // keeps a live handle after the gateway shuts down and never exits.
      if (typeof source?.pause === 'function') source.pause();
      await loop?.catch(() => {});
      rl = null;
      source = null;
      loop = null;
    },
  };
}

export default createStdioAdapter;

/**
 * streaming — the channel-agnostic half of "stream a turn back to a chat".
 *
 * Split out of adapters/telegram.mjs so the throttle / ordering / correlation
 * logic can be unit-tested with plain fakes (no grammy Bot, no real socket),
 * and so the next adapter (discord/slack/stdio) gets the same behaviour for
 * free. Nothing in here knows about Telegram — it talks to an abstract
 * "message surface" (`{ send(text), edit(text) }`) that the adapter supplies.
 *
 * ── Why submits are serialized gateway-wide (READ THIS BEFORE "fixing" it) ──
 *
 * `headless_bridge` event frames are NOT correlated to the submit that caused
 * them. Three independent facts make that unfixable from this side today:
 *
 *   1. extensions/headless_bridge.mjs's subscribe() sends
 *        send({ kind: 'event', event: topic || t, payload })
 *      — the `ref` field the protocol docblock advertises as `{ ref?, … }` is
 *      never actually populated for bus-driven events. Every subscriber on the
 *      connection sees every event, unattributed.
 *   2. extensions/assistant_stream_events.mjs emits `assistant.text` as
 *        bus.emit('assistant.text', { text: d.text })
 *      — payload carries the text and nothing else. No turn id, no request id.
 *   3. headless_bridge's submit op *does* pass `{ requestId: id }` into
 *      `__ccpSubmitInput`, but extensions/expose_submit_input.mjs's adapter
 *      (`function(__inp, __opts) { … return __ccpCb(__qc); }`) drops `__opts`
 *      on the floor, so that id never reaches the CLI — let alone the SSE tap
 *      in (2), which lives in the fetch interceptor and has no notion of which
 *      submit it belongs to anyway.
 *
 * So there is no id to filter on, and inventing one would mean patching three
 * files in the CLI-side patch chain — out of scope here. Rather than ship code
 * that silently interleaves two users' assistant text into each other's
 * messages, `streamTurn` funnels every submit through one process-wide
 * `bridgeTurns` queue: at most ONE submit is in flight across the whole
 * gateway, so while a turn is streaming, every `assistant.text` event on the
 * connection provably belongs to it.
 *
 * The cost is real and deliberate: concurrent chats wait their turn. That is
 * the honest behaviour for a gateway that fronts a single CLI session (see the
 * "Status" section of README.md).
 */

/** Telegram's hard cap is 4096 chars; the others are in the same ballpark. */
export const MAX_MESSAGE_CHARS = 4096;

/** Trailing-throttle interval for mid-turn edits. Telegram rate-limits edits. */
export const DEFAULT_EDIT_THROTTLE_MS = 1200;

/** Placeholder posted the instant a message is accepted, before the turn runs. */
export const DEFAULT_PLACEHOLDER = '…';

/** Clip to the channel's message cap, marking that we clipped. */
export const clip = (text, max = MAX_MESSAGE_CHARS) =>
  (text.length <= max ? text : text.slice(0, max - 1) + '…');

/**
 * Leading-edge + trailing-edge throttle.
 *
 * The first call runs immediately; further calls inside the cooldown window
 * collapse into a single trailing call with the newest arguments. That is what
 * keeps a 300-delta turn down to a handful of `editMessageText` requests
 * instead of 300 of them.
 *
 * Invocations of `fn` are chained, never overlapped — two edits of the same
 * message must not be in flight at once or they can land out of order.
 *
 * @param {(...args: any[]) => Promise<void> | void} fn
 * @param {number} intervalMs
 */
export function createThrottle(fn, intervalMs) {
  let timer = null;
  let pending = false;
  let lastArgs = null;
  let lastRun = -Infinity;
  let chain = Promise.resolve();

  const invoke = () => {
    pending = false;
    lastRun = Date.now();
    const args = lastArgs;
    lastArgs = null;
    chain = chain.then(() => fn(...args)).catch(() => { /* caller-supplied fn reports its own errors */ });
  };

  const throttled = (...args) => {
    lastArgs = args;
    pending = true;
    if (timer) return;
    const wait = intervalMs - (Date.now() - lastRun);
    if (wait <= 0) return invoke();
    timer = setTimeout(() => { timer = null; if (pending) invoke(); }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  };

  /** Drop any scheduled trailing call and forget it. */
  throttled.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pending = false;
    lastArgs = null;
  };

  /** Run any scheduled trailing call now, then wait for all in-flight calls. */
  throttled.flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending) invoke();
    await chain;
  };

  /** Wait for in-flight calls without triggering the pending one. */
  throttled.settled = () => chain;

  return throttled;
}

/**
 * Keyed FIFO chain — jobs sharing a key run strictly one after another, jobs
 * under different keys run concurrently. A hand-rolled `.then()` chain is the
 * right size for this scaffold; a job-queue dependency would not be.
 *
 * A rejected job does not poison its key's chain, and a key's entry is dropped
 * once it drains, so the map does not grow with the number of chats seen.
 */
export class SerialQueue {
  constructor() {
    /** @type {Map<any, Promise<void>>} */
    this._tails = new Map();
  }

  /** Number of keys with work queued or running (test/introspection aid). */
  get size() { return this._tails.size; }

  /**
   * @template T
   * @param {any} key
   * @param {() => Promise<T> | T} job
   * @returns {Promise<T>} resolves/rejects with `job`'s own outcome
   */
  run(key, job) {
    const prev = this._tails.get(key) || Promise.resolve();
    const result = prev.then(() => job(), () => job());
    const tail = result.then(() => {}, () => {});
    this._tails.set(key, tail);
    tail.then(() => { if (this._tails.get(key) === tail) this._tails.delete(key); });
    return result;
  }
}

/**
 * Process-wide submit lock. See the module header: bridge events are not
 * correlated to a submit, so exactly one submit may be in flight at a time for
 * mid-turn streaming to be attributable at all.
 */
export const bridgeTurns = new SerialQueue();

/** The single key every submit queues under — one lock, not one per chat. */
export const BRIDGE_TURN_KEY = 'bridge';

/**
 * Resolve a turn's real answer.
 *
 * Confirmed live against a real patched CLI (not just the test stub) on
 * 2026-08-21: `bridge.submit()`'s resolved value is NOT the assistant's
 * answer. `extensions/expose_submit_input.mjs` captures React's `submit`
 * useCallback — a void UI event handler that dispatches into the chat UI and
 * returns nothing usable, not a request/response function. The ONLY reliable
 * source of the turn's actual text is the accumulated `assistant.text`
 * stream. `submit()`'s return value is a fallback for the case where nothing
 * streamed at all (a tool-only turn with no text deltas, or a test double
 * that fabricates a `{final}`/`{text}` return instead of emitting events —
 * e.g. tests/bridge_host.mjs), not the primary source.
 *
 * @param {any} result - whatever bridge.submit() resolved with
 * @param {string} accumulated - text accumulated from assistant.text events
 * @returns {string}
 */
export function resolveTurnText(result, accumulated) {
  if (accumulated) return accumulated;
  const final = (result && (result.final ?? result.text)) ?? JSON.stringify(result ?? null);
  return String(final);
}

/**
 * Submit a prompt and return its real text, with no message-surface/UI
 * concerns (no placeholder, no throttled edits) — for adapters like stdio
 * that just want "the turn's answer" once, at the end. Still goes through
 * the gateway-wide `bridgeTurns` lock, same as streamTurn, for the same
 * correlation-safety reason (see the module header): assistant.text events
 * are unattributed, so only one submit — from ANY adapter sharing this
 * bridge connection — may be in flight at a time.
 *
 * @param {object} o
 * @param {{ on: Function, off: Function, submit: (p: string) => Promise<any> }} o.bridge
 * @param {string} o.prompt
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function submitAndCollect({ bridge, prompt }) {
  return bridgeTurns.run(BRIDGE_TURN_KEY, async () => {
    let accumulated = '';
    const onText = (payload) => {
      const chunk = payload && typeof payload.text === 'string' ? payload.text : '';
      if (chunk) accumulated += chunk;
    };
    bridge.on('assistant.text', onText);
    try {
      const result = await bridge.submit(prompt);
      return { ok: true, text: resolveTurnText(result, accumulated) };
    } catch (e) {
      return { ok: false, text: `error: ${e.message}` };
    } finally {
      bridge.off('assistant.text', onText);
    }
  });
}

/**
 * Post a placeholder, stream the turn's assistant text into it, and settle it
 * on the final result (or the error).
 *
 * @param {object} o
 * @param {{ on: Function, off: Function, submit: (p: string) => Promise<any> }} o.bridge
 * @param {string} o.prompt
 * @param {{ send: (text: string) => Promise<any>, edit: (text: string) => Promise<any> }} o.message
 * @param {(msg: string) => void} [o.log]
 * @param {number} [o.throttleMs]
 * @param {string} [o.placeholder]
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function streamTurn({
  bridge,
  prompt,
  message,
  log = () => {},
  throttleMs = DEFAULT_EDIT_THROTTLE_MS,
  placeholder = DEFAULT_PLACEHOLDER,
}) {
  // Acknowledge outside the lock: a chat waiting behind another chat's turn
  // should still see that its message was received.
  await message.send(placeholder);

  return bridgeTurns.run(BRIDGE_TURN_KEY, async () => {
    let accumulated = '';
    let lastSent = placeholder;

    const edit = async (text) => {
      const next = clip(text);
      // Telegram (and friends) reject an edit that changes nothing.
      if (!next || next === lastSent) return;
      lastSent = next;
      try { await message.edit(next); }
      catch (e) { log(`stream edit failed: ${e.message}`); }
    };

    const pushEdit = createThrottle(edit, throttleMs);
    const onText = (payload) => {
      const chunk = payload && typeof payload.text === 'string' ? payload.text : '';
      if (!chunk) return;
      accumulated += chunk;
      pushEdit(accumulated);
    };

    bridge.on('assistant.text', onText);
    try {
      const result = await bridge.submit(prompt);
      const text = resolveTurnText(result, accumulated);
      // Drop any trailing partial edit — the final text supersedes it.
      pushEdit.cancel();
      await pushEdit.settled();
      await edit(text || accumulated || '(empty result)');
      return { ok: true, text };
    } catch (e) {
      pushEdit.cancel();
      await pushEdit.settled();
      log(`submit failed: ${e.message}`);
      await edit(`error: ${e.message}`);
      return { ok: false, text: `error: ${e.message}` };
    } finally {
      bridge.off('assistant.text', onText);
    }
  });
}

export default streamTurn;

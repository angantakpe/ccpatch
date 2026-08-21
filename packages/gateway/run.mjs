#!/usr/bin/env node
/**
 * ccpatch gateway — connect to a running headless_bridge session and start
 * the configured channel adapters against it.
 *
 * This is the CLI counterpart to a patched CLI's headless_bridge socket: run
 * `claude` with the headless_bridge patch applied and CC_BRIDGE_ADDR set,
 * then run this against the same addr/token to make that session reachable
 * from Telegram (and, as more adapters land, other channels).
 *
 * Env:
 *   CC_BRIDGE_ADDR      required — unix:/path or tcp://host:port, must match
 *                        the value the patched CLI was started with.
 *   CC_BRIDGE_TOKEN      required — shared secret, must match the CLI side.
 *   GATEWAY_ADAPTERS     comma-separated adapter names to start (default: telegram).
 *
 * Each adapter reads its own channel-specific env — see the adapter's module
 * header (e.g. adapters/telegram.mjs for TELEGRAM_BOT_TOKEN /
 * TELEGRAM_ALLOWED_CHAT_IDS).
 */
import { BridgeClient } from './bridge-client.mjs';
import { loadConfig } from './config.mjs';
import { isChannelAdapter } from './adapter.mjs';
import { createTelegramAdapter } from './adapters/telegram.mjs';

const ADAPTER_FACTORIES = {
  telegram: createTelegramAdapter,
};

async function main() {
  const config = loadConfig();

  if (!config.bridge.addr || !config.bridge.token) {
    console.error('gateway: CC_BRIDGE_ADDR and CC_BRIDGE_TOKEN are required');
    process.exit(2);
  }
  if (!config.adapters.length) {
    console.error('gateway: no adapters configured (GATEWAY_ADAPTERS)');
    process.exit(2);
  }

  const bridge = new BridgeClient(config.bridge);
  bridge.on('error', (err) => console.error('[gateway] bridge error:', err.message));
  await bridge.connect();
  await bridge.subscribe(['turn.*', 'tool.*', 'assistant.*', 'cost.delta', 'agent.*']);
  console.log(`[gateway] connected to bridge at ${config.bridge.addr}`);

  const adapters = [];
  for (const name of config.adapters) {
    const factory = ADAPTER_FACTORIES[name];
    if (!factory) {
      console.error(`gateway: unknown adapter "${name}" (known: ${Object.keys(ADAPTER_FACTORIES).join(', ')})`);
      process.exit(2);
    }
    const adapter = factory();
    if (!isChannelAdapter(adapter)) {
      console.error(`gateway: adapter "${name}" does not satisfy the ChannelAdapter contract`);
      process.exit(2);
    }
    await adapter.start({ bridge, log: (...args) => console.log(`[gateway:${adapter.name}]`, ...args) });
    adapters.push(adapter);
    console.log(`[gateway] adapter started: ${adapter.name}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down…`);
    await Promise.all(adapters.map((a) => a.stop().catch((e) => console.error(`[gateway] ${a.name} stop failed:`, e.message))));
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('gateway: fatal:', e);
  process.exit(1);
});

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// These are structural / runtime-eval tests against the patch's *generated*
// code (applied to a shebang stub) — they do NOT require a real patched bundle,
// so they run in the normal suite. The CCPATCH_INTEGRATION gate was removed when
// the allowlist (default-deny) coverage below was added.

// Structural test: verify headless_bridge.mjs patch code includes auth checks
describe('headless_bridge auth', () => {
  test('patch output includes __ccpAuthToken check', async () => {
    // Import the patch module and inspect its generated code
    const patch = (await import('../extensions/headless_bridge.mjs')).default
    // Get the patch's apply output string by calling apply with a minimal fixture
    const stubShebang = '#!/usr/bin/env node'
    const patchSrc = patch.apply ? patch.apply(stubShebang + '\n// stub\n') : ''
    // The bridge must reference auth token validation
    const src = patchSrc + JSON.stringify(patch)
    assert.ok(
      src.includes('__ccpAuth') || src.includes('authToken') || src.includes('auth_token'),
      'headless_bridge patch must reference auth token validation'
    )
  })

  test('patch output rejects unauthenticated hello', async () => {
    const patch = (await import('../extensions/headless_bridge.mjs')).default
    const stubShebang = '#!/usr/bin/env node'
    const patchSrc = patch.apply ? patch.apply(stubShebang + '\n// stub\n') : ''
    // The bridge must call .verify() on the presented token
    assert.ok(
      patchSrc.includes('.verify(') || patchSrc.includes('verify(msg.token)'),
      'headless_bridge patch must call auth.verify() on the presented token'
    )
  })

  test('patch output destroys socket on auth failure', async () => {
    const patch = (await import('../extensions/headless_bridge.mjs')).default
    const stubShebang = '#!/usr/bin/env node'
    const patchSrc = patch.apply ? patch.apply(stubShebang + '\n// stub\n') : ''
    // The bridge must destroy the socket when auth fails
    assert.ok(
      patchSrc.includes('sock.destroy()'),
      'headless_bridge patch must destroy the socket on auth failure'
    )
  })

  test('patch declares dependsOn auth_token', async () => {
    const patch = (await import('../extensions/headless_bridge.mjs')).default
    const deps = patch.dependsOn ?? []
    assert.ok(
      deps.includes('auth_token'),
      'headless_bridge must declare dependsOn: auth_token'
    )
  })

  test('patch output requires hello op before other ops', async () => {
    const patch = (await import('../extensions/headless_bridge.mjs')).default
    const stubShebang = '#!/usr/bin/env node'
    const patchSrc = patch.apply ? patch.apply(stubShebang + '\n// stub\n') : ''
    // The bridge must track authed state and gate on it
    assert.ok(
      patchSrc.includes('authed') && patchSrc.includes("op !== 'hello'"),
      "headless_bridge patch must track authed state and reject non-hello ops before auth"
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tool-dispatch allowlist — DEFAULT-DENY (security review fix).
//
// Drive the injected bridge IIFE against stubbed net/auth/tool globals so we
// can exercise the real `dispatch` decision: unset ⇒ deny with an actionable
// error, '*' ⇒ allow, a named list ⇒ only those tools.
// ─────────────────────────────────────────────────────────────────────────────
describe('headless_bridge tool-dispatch allowlist (default-deny)', () => {
  /** Apply the patch to a shebang stub and strip the hashbang (illegal in a Function body). */
  async function applied() {
    const patch = (await import('../extensions/headless_bridge.mjs')).default
    const out = patch.apply('#!/usr/bin/env node\nvoid 0;\n')
    return out.replace(/^#![^\n]*\n/, '')
  }

  /**
   * Boot the bridge with stubbed net + globals, return a driver that can feed
   * NDJSON frames into the connection handler and read back parsed responses.
   */
  async function makeBridge(envVars) {
    const warnings = []
    let connHandler = null

    // Stub net: capture the connection callback; listen/on are no-ops.
    const net = {
      createServer(cb) {
        connHandler = cb
        return {
          on() {},
          listen(...args) {
            const cb = args[args.length - 1]
            if (typeof cb === 'function') { try { cb() } catch (_) {} }
          },
          address() { return { address: '127.0.0.1', port: 0 } },
        }
      },
    }
    const fs = { unlinkSync() {}, chmodSync() {}, statSync() { return { mode: 0o600 } } }
    const require = (m) => {
      if (m === 'node:net') return net
      if (m === 'node:fs') return fs
      throw new Error('unexpected require: ' + m)
    }

    const invocations = []
    const g = {
      __ccpAuth: { verify: () => true },
      __ccpInvokeTool: async (name, input) => { invocations.push({ name, input }); return { content: [{ type: 'text', text: 'ok:' + name }] } },
    }

    // Loopback TCP avoids the unix-socket fs path.
    const proc = {
      pid: 1234,
      env: { CC_BRIDGE_ADDR: 'tcp://127.0.0.1:0', ...envVars },
      on() {},
    }
    const console = { warn: (...a) => warnings.push(a.join(' ')), error: () => {}, log: () => {} }

    const fn = new Function(
      'require', 'process', 'globalThis', 'console', 'setTimeout', 'AbortController',
      await applied(),
    )
    fn(require, proc, g, console, (f) => { try { f() } catch (_) {} return 0 }, AbortController)

    assert.ok(connHandler, 'bridge must register a connection handler')

    // Build a fake socket and open a connection.
    const sent = []
    let dataHandler = null
    const sock = {
      write(s) { for (const line of String(s).split('\n')) { if (line) sent.push(JSON.parse(line)) } return true },
      on(ev, cb) { if (ev === 'data') dataHandler = cb },
      destroy() {}, end() {},
    }
    connHandler(sock)
    assert.ok(dataHandler, 'connection handler must attach a data listener')

    const feed = async (obj) => {
      dataHandler(JSON.stringify(obj) + '\n')
      // let async handle() settle
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 1))
    }

    return { feed, sent, warnings, invocations }
  }

  test('unset ⇒ one-time loud startup warning naming the variable and both forms', async () => {
    const { warnings } = await makeBridge({}) // no CC_BRIDGE_TOOL_ALLOWLIST
    const w = warnings.join('\n')
    assert.match(w, /CC_BRIDGE_TOOL_ALLOWLIST/)
    assert.match(w, /DENY-ALL/i)
    assert.match(w, /"\*"/)
  })

  test('unset ⇒ dispatch denied with an actionable error', async () => {
    const { feed, sent } = await makeBridge({})
    await feed({ id: 1, op: 'hello', token: 'x' })
    await feed({ id: 2, op: 'dispatch', name: 'Bash', input: {} })
    const reply = sent.find((m) => m.id === 2)
    assert.ok(reply, 'expected a reply to the dispatch frame')
    assert.equal(reply.ok, false)
    // Actionable: names the var, the per-tool form (the tool name) AND the '*' form.
    assert.match(reply.error, /CC_BRIDGE_TOOL_ALLOWLIST/)
    assert.match(reply.error, /Bash/)
    assert.match(reply.error, /\*/)
  })

  test("'*' ⇒ every tool dispatchable", async () => {
    const { feed, sent, invocations } = await makeBridge({ CC_BRIDGE_TOOL_ALLOWLIST: '*' })
    await feed({ id: 1, op: 'hello', token: 'x' })
    await feed({ id: 2, op: 'dispatch', name: 'Bash', input: { command: 'ls' } })
    const reply = sent.find((m) => m.id === 2)
    assert.ok(reply && reply.ok === true, 'dispatch should succeed under "*"')
    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].name, 'Bash')
  })

  test('named list ⇒ only listed tools; others denied', async () => {
    const { feed, sent, invocations } = await makeBridge({ CC_BRIDGE_TOOL_ALLOWLIST: 'Read, Grep' })
    await feed({ id: 1, op: 'hello', token: 'x' })
    await feed({ id: 2, op: 'dispatch', name: 'Read', input: { file_path: '/x' } })
    await feed({ id: 3, op: 'dispatch', name: 'Write', input: { file_path: '/x', content: 'y' } })

    const allowed = sent.find((m) => m.id === 2)
    assert.ok(allowed && allowed.ok === true, 'Read (listed) should be allowed')

    const denied = sent.find((m) => m.id === 3)
    assert.ok(denied && denied.ok === false, 'Write (not listed) should be denied')
    assert.match(denied.error, /CC_BRIDGE_TOOL_ALLOWLIST/)
    assert.match(denied.error, /Write/)

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].name, 'Read')
  })

  test('allowlist does NOT gate non-dispatch ops (subscribe works deny-all)', async () => {
    const { feed, sent } = await makeBridge({}) // deny-all
    await feed({ id: 1, op: 'hello', token: 'x' })
    await feed({ id: 2, op: 'subscribe', topics: ['tool.call'] })
    const reply = sent.find((m) => m.id === 2)
    assert.ok(reply && reply.ok === true, 'subscribe must work regardless of the tool allowlist')
  })
})

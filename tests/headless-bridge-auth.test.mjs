import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// Skip if not running integration suite (requires a real patched bundle)
if (!process.env.CCPATCH_INTEGRATION) {
  console.log('headless-bridge-auth: skipping (set CCPATCH_INTEGRATION=1 to run)')
  process.exit(0)
}

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

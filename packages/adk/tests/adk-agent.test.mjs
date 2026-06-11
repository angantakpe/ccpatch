// Targeted tests for packages/adk/agent.mjs — silent redefine / freeze and
// disposeAgentScope. Does NOT touch adk-core.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentScope,
  defineAgentIn,
  getAgentIn,
  listAgentsIn,
  disposeAgentScope,
} from '../agent.mjs';

/**
 * Capture console.warn calls + agent.redefined bus events for the duration of
 * `fn`, restoring globals afterward. Returns { warnings, events }.
 */
function withCapture(fn) {
  const origWarn = console.warn;
  const origBus = globalThis.__ccpBus;
  const warnings = [];
  const events = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  globalThis.__ccpBus = { emit: (topic, payload) => { events.push({ topic, payload }); } };
  try {
    fn();
  } finally {
    console.warn = origWarn;
    if (origBus === undefined) delete globalThis.__ccpBus;
    else globalThis.__ccpBus = origBus;
  }
  return { warnings, events };
}

test('identical redefine is a silent no-op (no warn, no bus event)', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'planner', systemPrompt: 'plan carefully' });

  const { warnings, events } = withCapture(() => {
    const ret = defineAgentIn(scope, { name: 'planner', systemPrompt: 'plan carefully' });
    // no-op returns the already-stored def
    assert.equal(ret.systemPrompt, 'plan carefully');
  });

  assert.equal(warnings.length, 0, 'identical redefine must not warn');
  assert.equal(events.length, 0, 'identical redefine must not emit agent.redefined');
  assert.equal(listAgentsIn(scope).length, 1);
});

test('changed redefine warns once-per-name AND emits agent.redefined', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'planner', systemPrompt: 'v1' });

  const { warnings, events } = withCapture(() => {
    defineAgentIn(scope, { name: 'planner', systemPrompt: 'v2' });
    // second changed redefine: bus still fires every time, console warns once
    defineAgentIn(scope, { name: 'planner', systemPrompt: 'v3' });
  });

  assert.equal(warnings.length, 1, 'console.warn deduped once-per-name');
  assert.match(warnings[0], /planner/);
  assert.match(warnings[0], /DIFFERENT systemPrompt/);

  const redefs = events.filter((e) => e.topic === 'agent.redefined');
  assert.equal(redefs.length, 2, 'bus emits on every changed redefine');
  assert.deepEqual(redefs[0].payload, { name: 'planner' });

  // The overwrite still landed (backward-compatible behavior).
  assert.equal(getAgentIn(scope, 'planner').systemPrompt, 'v3');
});

test('debug switch makes the warning louder (prompt previews)', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'planner', systemPrompt: 'secret-v1' });

  const prev = globalThis.__ccpDebug;
  globalThis.__ccpDebug = true;
  const { warnings } = withCapture(() => {
    defineAgentIn(scope, { name: 'planner', systemPrompt: 'secret-v2' });
  });
  if (prev === undefined) delete globalThis.__ccpDebug;
  else globalThis.__ccpDebug = prev;

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /secret-v1/);
  assert.match(warnings[0], /secret-v2/);
});

test('frozen agent: changed redefine THROWS a clear error', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'guard', systemPrompt: 'locked', frozen: true });

  assert.throws(
    () => defineAgentIn(scope, { name: 'guard', systemPrompt: 'tampered' }),
    /frozen/,
  );
  // The frozen persona is untouched.
  assert.equal(getAgentIn(scope, 'guard').systemPrompt, 'locked');
});

test('frozen agent: identical redefine is a no-op (no throw, no warn)', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'guard', systemPrompt: 'locked', frozen: true });

  const { warnings, events } = withCapture(() => {
    assert.doesNotThrow(() => {
      const ret = defineAgentIn(scope, { name: 'guard', systemPrompt: 'locked' });
      assert.equal(ret.frozen, true);
    });
  });
  assert.equal(warnings.length, 0);
  assert.equal(events.length, 0);
});

test('frozen flag can be added via an identical redefine (privilege tightening)', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'mut', systemPrompt: 'same' });
  assert.notEqual(getAgentIn(scope, 'mut').frozen, true);

  defineAgentIn(scope, { name: 'mut', systemPrompt: 'same', frozen: true });
  assert.equal(getAgentIn(scope, 'mut').frozen, true);

  // Now it's frozen — a changed redefine throws.
  assert.throws(() => defineAgentIn(scope, { name: 'mut', systemPrompt: 'other' }), /frozen/);
});

test('disposeAgentScope clears the registry; idempotent', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'a', systemPrompt: 'x' });
  defineAgentIn(scope, { name: 'b', systemPrompt: 'y' });
  assert.equal(listAgentsIn(scope).length, 2);

  disposeAgentScope(scope);
  assert.equal(listAgentsIn(scope).length, 0);
  assert.equal(getAgentIn(scope, 'a'), null);

  // Idempotent: second dispose is a quiet no-op, even on a bare object.
  assert.doesNotThrow(() => disposeAgentScope(scope));
  assert.doesNotThrow(() => disposeAgentScope({}));
  assert.doesNotThrow(() => disposeAgentScope(undefined));
});

test('disposeAgentScope resets the once-per-name warn ledger', () => {
  const scope = createAgentScope();
  defineAgentIn(scope, { name: 'planner', systemPrompt: 'v1' });

  const first = withCapture(() => {
    defineAgentIn(scope, { name: 'planner', systemPrompt: 'v2' });
  });
  assert.equal(first.warnings.length, 1);

  disposeAgentScope(scope);

  // Fresh population in the re-used scope warns again (ledger was cleared).
  defineAgentIn(scope, { name: 'planner', systemPrompt: 'w1' });
  const second = withCapture(() => {
    defineAgentIn(scope, { name: 'planner', systemPrompt: 'w2' });
  });
  assert.equal(second.warnings.length, 1);
});

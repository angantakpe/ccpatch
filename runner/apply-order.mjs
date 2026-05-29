/**
 * Apply-ordering for the runner.
 *
 * Splits two concerns that used to live inline in applyNamedPatches:
 *   1. PHASE_ORDER / phaseOf — the pre<main<post phase rank.
 *   2. orderPatches() — the priority-respecting topological sort that decides
 *      the exact apply sequence.
 *
 * ── The ordering guarantee (priority wiring, task 1) ─────────────────────────
 * orderPatches() produces a linear order satisfying, in strict precedence:
 *
 *   (1) PHASE first: every `pre` patch precedes every `main`, every `main`
 *       precedes every `post`. (Cross-phase dependsOn must already point to a
 *       same-or-earlier phase — the caller enforces that separately, so phase
 *       can dominate without ever violating a real dependency edge.)
 *
 *   (2) dependsOn (topological) SECOND, and it DOMINATES priority: a patch
 *       never precedes any patch it (transitively) dependsOn. This is the hard
 *       correctness invariant and is never traded away for priority.
 *
 *   (3) priority THIRD — it ONLY orders patches that are otherwise free to run
 *       in either order (no dependency path between them, same phase). Lower
 *       `priority` runs first. Default priority is 1000.
 *
 *   (4) original enable-list index LAST — a stable final tie-breaker so the
 *       order is deterministic when phase, dependency-readiness and priority
 *       are all equal.
 *
 * Implementation: a Kahn-style topological sort. We repeatedly pick, from the
 * set of nodes whose dependencies are already emitted ("ready"), the single
 * best node by the comparator (phase, priority, index). Because we only ever
 * pick from ready nodes, (2) is structurally guaranteed; because the comparator
 * orders ready nodes by phase then priority then index, (1)/(3)/(4) fall out.
 *
 * NOTE: a dependsOn edge that crosses a priority preference still wins. e.g. if
 * B dependsOn A but A.priority=5000 and B.priority=1 (B "wants" to go first),
 * A still runs first — priority cannot reorder across a real edge. Priority only
 * decides among nodes that are simultaneously ready.
 */

export const PHASE_ORDER = { pre: 0, main: 1, post: 2 };

export function phaseOf(patch) {
  return patch?.phase ?? 'main';
}

function priorityOf(patch) {
  const p = patch?.priority;
  return (typeof p === 'number' && Number.isFinite(p)) ? p : 1000;
}

/**
 * Priority-respecting topological order over `names`.
 *
 * @param {string[]} names    enabled patch names, in enable-list order
 * @param {Record<string, object>} patches  raw patch modules (read dependsOn,
 *                                           phase, priority)
 * @param {string[]} topoOrdered  a valid linear extension of the dependsOn graph
 *                                 (from topoSort) — used purely as the source of
 *                                 the canonical node set / cycle-free guarantee.
 * @returns {string[]} the apply order
 */
export function orderPatches(names, patches, topoOrdered) {
  const indexOf = new Map(names.map((n, i) => [n, i]));
  const nodes = topoOrdered.filter((n) => patches[n]);

  // Build in-degree from dependsOn edges that point at enabled nodes.
  const enabled = new Set(nodes);
  const remainingDeps = new Map(); // name -> count of not-yet-emitted deps
  for (const n of nodes) {
    const deps = (patches[n] && patches[n].dependsOn) ? patches[n].dependsOn : [];
    let count = 0;
    for (const d of deps) if (enabled.has(d)) count++;
    remainingDeps.set(n, count);
  }

  // Comparator over READY nodes: phase, then priority, then enable-list index.
  const less = (a, b) => {
    const pa = PHASE_ORDER[phaseOf(patches[a])] ?? PHASE_ORDER.main;
    const pb = PHASE_ORDER[phaseOf(patches[b])] ?? PHASE_ORDER.main;
    if (pa !== pb) return pa - pb;
    const wa = priorityOf(patches[a]);
    const wb = priorityOf(patches[b]);
    if (wa !== wb) return wa - wb;
    return (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0);
  };

  const ready = nodes.filter((n) => remainingDeps.get(n) === 0);
  const result = [];
  while (ready.length > 0) {
    // Pick the best ready node. Linear scan keeps this dependency-free and is
    // fine for the patch counts we deal with (dozens, not millions).
    let bestIdx = 0;
    for (let i = 1; i < ready.length; i++) {
      if (less(ready[i], ready[bestIdx]) < 0) bestIdx = i;
    }
    const [picked] = ready.splice(bestIdx, 1);
    result.push(picked);
    // Decrement dependents that listed `picked`; newly-zero ones become ready.
    for (const n of nodes) {
      if (remainingDeps.get(n) <= 0) continue;
      const deps = (patches[n] && patches[n].dependsOn) ? patches[n].dependsOn : [];
      if (deps.includes(picked)) {
        const c = remainingDeps.get(n) - 1;
        remainingDeps.set(n, c);
        if (c === 0) ready.push(n);
      }
    }
  }

  // Fallback: if a cycle slipped through (topoSort should have thrown first),
  // append any unemitted nodes in topo order so nothing is silently dropped.
  if (result.length < nodes.length) {
    for (const n of nodes) if (!result.includes(n)) result.push(n);
  }
  return result;
}

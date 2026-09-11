// Per-kind-of-work floors (2026-08-22). A min_cost or compound policy may
// carry clusterFloors; the request is served under the floor of the cluster
// it was assigned to, and under qualityFloor everywhere else. The learning
// period proposes one floor per cluster, so applying a proposal MERGES that
// cluster's floor into the org's bound policy instead of replacing the whole
// policy — which is what 'apply' did before, silently dropping a floor set
// for another kind of work.
import type { Policy } from '@potion/core';
import { DEFAULT_ORG_POLICY } from '@potion/pareto';
// The serving-side half (policyForCluster) moved to @potion/pareto's serving
// module (2026-08-31, one-resolver P0) so the learning period runs the exact
// serve chain; re-exported here so every existing import keeps working.
export { policyForCluster } from '@potion/pareto';

export function floorFor(policy: Policy, clusterId: string): number | null {
  if (policy.type !== 'min_cost' && policy.type !== 'compound') return null;
  const own = policy.clusterFloors?.[clusterId];
  return typeof own === 'number' ? own : policy.qualityFloor;
}

/**
 * Merge one cluster's floor into an existing policy. A min_cost/compound
 * policy keeps its default floor and gains (or updates) the cluster entry;
 * any other policy, or none, becomes min_cost with this floor as the default
 * too — the first proposal an org applies sets its bar.
 */
/**
 * THE ONE FLOOR-MINTING RULE (2026-09-11). Every path that turns a
 * measurement into a bound quality floor goes through here: the learning
 * proposal apply, the /api/floor control, and the plan page's "route on
 * this point" binding. Before this each path had its own arithmetic — apply
 * floored to 2dp, /api/floor ROUNDED to 2dp, and the plan binding wrote the
 * raw lower bound unrounded (0.978543771043771 went live as a GLOBAL floor
 * on 2026-08-22 and put every other cluster onto the priciest point).
 *
 * FLOOR, never round: a bar is a promise, and rounding 0.855 up to 0.86
 * promises something the measurement did not show. Bounded to [0, 1], which
 * is all core PolicySchema requires.
 */
export function mintFloor(measured: number): number {
  if (!Number.isFinite(measured)) return 0;
  return Math.max(0, Math.min(1, Math.floor(measured * 100) / 100));
}

export function withClusterFloor(policy: Policy | null, clusterId: string, floor: number): Policy {
  if (policy && (policy.type === 'min_cost' || policy.type === 'compound')) {
    return { ...policy, clusterFloors: { ...(policy.clusterFloors ?? {}), [clusterId]: floor } };
  }
  // A CLUSTER floor, not a global one (2026-09-11). Seeding the top-level
  // floor from this cluster's measurement made one kind of work's bar
  // govern every other kind the key serves — a classification bar of 1.0
  // became the floor on agentic-tool-use, nothing cleared it, and the
  // priciest point served. The clusters this policy says nothing about get
  // what a fresh key gets: the platform default.
  const base = DEFAULT_ORG_POLICY.type === 'min_cost' ? DEFAULT_ORG_POLICY.qualityFloor : 0.95;
  return { type: 'min_cost', qualityFloor: base, clusterFloors: { [clusterId]: floor } };
}

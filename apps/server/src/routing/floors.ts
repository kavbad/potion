// Per-kind-of-work floors (2026-08-22). A min_cost or compound policy may
// carry clusterFloors; the request is served under the floor of the cluster
// it was assigned to, and under qualityFloor everywhere else. The learning
// period proposes one floor per cluster, so applying a proposal MERGES that
// cluster's floor into the org's bound policy instead of replacing the whole
// policy — which is what 'apply' did before, silently dropping a floor set
// for another kind of work.
import type { Policy } from '@potion/core';
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
export function withClusterFloor(policy: Policy | null, clusterId: string, floor: number): Policy {
  if (policy && (policy.type === 'min_cost' || policy.type === 'compound')) {
    return { ...policy, clusterFloors: { ...(policy.clusterFloors ?? {}), [clusterId]: floor } };
  }
  return { type: 'min_cost', qualityFloor: floor, clusterFloors: { [clusterId]: floor } };
}

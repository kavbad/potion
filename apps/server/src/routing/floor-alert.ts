// THE FLOOR-INFEASIBLE ALERT (2026-09-16). When a key's floor admits no
// measured point on a kind of work, the serve path serves the best-quality
// point at a premium, marks the receipt fallback=1 with reason
// policy_infeasible, and — until today — told nobody. The `policy_infeasible`
// alert event existed but fired only for latency (compound) policies.
//
// Once per episode, not per request: a key serving a thousand infeasible
// requests must mint ONE alert. The latency path dedupes through a durable
// policy condition; this one dedupes in process (F18 forbids >1 replica, so
// in-process is the whole fleet), with a TTL so a floor still infeasible
// tomorrow is mentioned again tomorrow. A restart re-mentions it once.
import type { Policy } from '@potion/core';
import { qualityLowerBound, type Frontier } from '@potion/core';
import { emitAlert } from '../alerts.js';
import type { PotionContext } from '../context.js';
import { floorFor } from './floors.js';

const TTL_MS = 6 * 60 * 60 * 1000;
const seen = new Map<string, number>();

/** Tests: forget every episode. */
export function resetFloorInfeasibleAlerts(): void {
  seen.clear();
}

export async function alertFloorInfeasible(
  ctx: PotionContext,
  args: {
    orgId: string;
    policyId: string | null;
    clusterId: string;
    policy: Policy;
    frontier: Frontier | null;
    servedStrategy: string;
  },
  now: number = Date.now(),
): Promise<boolean> {
  // An inline override has no durable configuration to alert about.
  if (args.policyId === null) return false;
  const key = `${args.orgId}|${args.policyId}|${args.clusterId}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < TTL_MS) return false;
  seen.set(key, now);
  const floor = floorFor(args.policy, args.clusterId);
  let highestProvable: number | null = null;
  let bestModel: string | null = null;
  for (const p of args.frontier?.points ?? []) {
    const lb = qualityLowerBound(p);
    if (highestProvable === null || lb > highestProvable) {
      highestProvable = lb;
      const cfg = p.strategyConfig as { model?: string; name?: string; type: string };
      bestModel = cfg.model ?? cfg.name ?? cfg.type;
    }
  }
  await emitAlert(ctx, {
    orgId: args.orgId,
    event: 'policy_infeasible',
    detail: {
      leg: 'floor',
      condition: 'floor_infeasible',
      policyId: args.policyId,
      clusterId: args.clusterId,
      qualityFloor: floor,
      highestProvable,
      bestModel,
      servedStrategy: args.servedStrategy,
      narrative:
        `On '${args.clusterId}', no measured model can prove quality ${floor === null ? '?' : floor.toFixed(2)}` +
        (highestProvable === null ? '' : ` — the highest provable is ${highestProvable.toFixed(2)} (${bestModel})`) +
        `. Requests there are served by the best-quality point at a premium, marked fallback=1. ` +
        `Lower the floor for this kind of work in Settings → Controls, or leave it and accept the premium.`,
    },
  });
  return true;
}

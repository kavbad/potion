// G2 RUNG 1 — ORG WORKLOAD DISCOVERY (2026-09-01, review §16: "the fixed
// taxonomy should become a prior, not the ontology").
//
// The org's consented learning samples (already redacted at capture) are
// clustered WITHIN each serving cluster — the discovery finds the
// sub-structure the taxonomy prior cannot see ("these calls that all
// looked like classification form two stable workloads"). Doctrine:
//   · OBSERVED, not routed. Rows land as status 'observed' in
//     org_workloads; routing adoption is a later, explicit rung — nothing
//     changes silently because a clustering ran.
//   · The text embedded is THE SAME text serving classifies on (user turns
//     joined) — a discovery made on different features would describe a
//     different router.
//   · Labels are never fabricated: the exemplar IS the medoid sample's
//     (redacted) text, and every group carries its cohesion so a reader
//     can weigh it.
//   · Snapshot semantics: each run replaces the org's rows — the table is
//     the current observed structure, not history.
import { and, eq, gt } from 'drizzle-orm';
import {
  listOrgIdsWithSpans,
  replaceOrgWorkloads,
  traceSpans,
  type NewOrgWorkload,
} from '@potion/db';
import {
  cosineSim,
  meanCentroid,
  orgHashOf,
  resolveAgentClusterThreshold,
  withDeliveryGuard,
  type WorkerHandler,
} from './handlers.js';
import { LEARNING_SPAN_NAME, parseSampledMessages } from './learning-period.js';

/** A group below this many samples is noise, not a workload. */
export const WORKLOAD_MIN_SAMPLES = 5;
/** Exemplar snippet length on the stored row (display honesty: enough to
 * recognize the work, short enough to stay a snippet). */
export const WORKLOAD_EXEMPLAR_CHARS = 120;
/** Discovery window (UTC days) — structure older than this is history. */
export const WORKLOAD_WINDOW_DAYS = 30;

export interface DiscoverySample {
  id: string;
  parentCluster: string;
  /** User turns joined — the serve path's own classification text. */
  text: string;
}

export interface DiscoveredGroup {
  parentCluster: string;
  /** Indexes into the input sample array. */
  members: number[];
  centroid: number[];
  /** Mean cosine of members to the FINAL centroid. */
  cohesion: number;
  /** The medoid — the member closest to the centroid. */
  exemplarIndex: number;
}

/**
 * Pure clustering: greedy cosine against running-mean centroids (the
 * traces:cluster recipe), per parent cluster, sorted by sample id first so
 * the grouping is a function of the sample SET, not arrival order. Groups
 * below WORKLOAD_MIN_SAMPLES are dropped (returned count tells the caller
 * how many samples that excluded).
 */
export function discoverGroups(
  samples: DiscoverySample[],
  vectors: number[][],
  threshold: number,
): { groups: DiscoveredGroup[]; noiseSamples: number } {
  const order = samples
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0));
  const byParent = new Map<string, number[]>();
  for (const { s, i } of order) {
    const list = byParent.get(s.parentCluster) ?? [];
    list.push(i);
    byParent.set(s.parentCluster, list);
  }
  const groups: DiscoveredGroup[] = [];
  let noiseSamples = 0;
  for (const [parentCluster, idxs] of [...byParent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const local: { members: number[]; centroid: number[] }[] = [];
    for (const i of idxs) {
      const v = vectors[i]!;
      let best = -1;
      let bestSim = -1;
      local.forEach((g, gi) => {
        const sim = cosineSim(v, g.centroid);
        if (sim > bestSim) {
          bestSim = sim;
          best = gi;
        }
      });
      if (best >= 0 && bestSim >= threshold) {
        const g = local[best]!;
        g.members.push(i);
        g.centroid = meanCentroid(g.members.map((m) => vectors[m]!));
      } else {
        local.push({ members: [i], centroid: v });
      }
    }
    for (const g of local) {
      if (g.members.length < WORKLOAD_MIN_SAMPLES) {
        noiseSamples += g.members.length;
        continue;
      }
      const sims = g.members.map((m) => cosineSim(vectors[m]!, g.centroid));
      const cohesion = sims.reduce((a, b) => a + b, 0) / sims.length;
      let exemplarIndex = g.members[0]!;
      let bestSim = -1;
      g.members.forEach((m, k) => {
        if (sims[k]! > bestSim) {
          bestSim = sims[k]!;
          exemplarIndex = m;
        }
      });
      groups.push({ parentCluster, members: g.members, centroid: g.centroid, cohesion, exemplarIndex });
    }
  }
  return { groups, noiseSamples };
}

export interface WorkloadsDiscoverResult {
  orgs: number;
  samplesSeen: number;
  discovered: number;
  noiseSamples: number;
  workloads: Array<{ orgId: string; id: string; parentCluster: string; sampleCount: number; cohesion: number }>;
}

/** workloads:discover — one org when named, else every org with spans. */
export const workloadsDiscoverHandler: WorkerHandler<'workloads:discover'> = async (payload, ctx) => {
  const embedder = ctx.embedder;
  if (embedder === undefined) {
    throw new Error('workloads:discover requires JobContext.embedder (platform embedder)');
  }
  const threshold = resolveAgentClusterThreshold({
    embedderKind: ctx.embedderKind,
    warn: (m) => console.warn(`[potion] ${m}`),
  });
  const since = new Date(Date.now() - WORKLOAD_WINDOW_DAYS * 86_400_000);
  const orgIds = payload.orgId !== undefined ? [payload.orgId] : await listOrgIdsWithSpans(ctx.db, since);
  const result: WorkloadsDiscoverResult = { orgs: 0, samplesSeen: 0, discovered: 0, noiseSamples: 0, workloads: [] };

  for (const orgId of orgIds) {
    await withDeliveryGuard('workloads:discover', ctx, orgId, async () => {
      const rows = await ctx.db
        .select({ traceId: traceSpans.traceId, attrs: traceSpans.attrs })
        .from(traceSpans)
        .where(and(eq(traceSpans.orgId, orgId), eq(traceSpans.name, LEARNING_SPAN_NAME), gt(traceSpans.ts, since)));
      const samples: DiscoverySample[] = [];
      for (const r of rows) {
        const a = r.attrs as Record<string, unknown>;
        const parentCluster = typeof a['potion.cluster_id'] === 'string' ? a['potion.cluster_id'] : null;
        if (parentCluster === null) continue;
        const full = parseSampledMessages(a['potion.messages']);
        const text =
          full !== null
            ? full.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
            : typeof a['gen_ai.prompt'] === 'string'
              ? a['gen_ai.prompt']
              : '';
        if (text.length === 0) continue;
        samples.push({ id: r.traceId, parentCluster, text });
      }
      result.orgs += 1;
      result.samplesSeen += samples.length;
      if (samples.length === 0) {
        await replaceOrgWorkloads(ctx.db, orgId, []);
        return;
      }
      // Samples were redacted AT CAPTURE (learning sampler) — nothing raw
      // reaches the embedder here.
      const vectors = await embedder.embed(samples.map((s) => s.text));
      const { groups, noiseSamples } = discoverGroups(samples, vectors, threshold);
      result.noiseSamples += noiseSamples;

      const safe = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const perParentCount = new Map<string, number>();
      const newRows: NewOrgWorkload[] = groups.map((g) => {
        const n = (perParentCount.get(g.parentCluster) ?? 0) + 1;
        perParentCount.set(g.parentCluster, n);
        return {
          id: `wl-${orgHashOf(orgId)}-${safe(g.parentCluster)}-${n}`,
          orgId,
          parentCluster: g.parentCluster,
          sampleCount: g.members.length,
          cohesion: g.cohesion,
          exemplarText: samples[g.exemplarIndex]!.text.slice(0, WORKLOAD_EXEMPLAR_CHARS),
          centroid: g.centroid,
          status: 'observed',
          windowDays: WORKLOAD_WINDOW_DAYS,
        };
      });
      await replaceOrgWorkloads(ctx.db, orgId, newRows);
      result.discovered += newRows.length;
      for (const r of newRows) {
        result.workloads.push({ orgId, id: r.id, parentCluster: r.parentCluster, sampleCount: r.sampleCount, cohesion: r.cohesion });
      }
    });
  }
  return result;
};

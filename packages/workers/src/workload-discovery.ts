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
import { PolicySchema, strategyHash, type ChatMessage, type EvalItem, type Policy } from '@potion/core';
import { DEFAULT_ORG_POLICY, servingDecisionFor } from '@potion/pareto';
import {
  evalRuns,
  getFirstApiKeyWithPolicy,
  getOrgIncumbents,
  getPolicyById,
  learningSpendSince,
  listAdoptedWorkloads,
  listOrgIdsWithSpans,
  loadDerivedSuite,
  pairedQualities,
  replaceOrgWorkloads,
  setWorkloadMeasurement,
  traceSpans,
  upsertDerivedSuite,
  type NewOrgWorkload,
} from '@potion/db';
import { randomUUID } from 'node:crypto';
import { runEval } from '@potion/harness';
import { loadPrices } from '@potion/providers';
import {
  computeRetention,
  cosineSim,
  deriveSuiteVerifyCapUsd,
  DEFAULT_RETENTION_FLOOR,
  emitAlertEvent,
  LIVE_SWEEP_ANSWER_MAX_TOKENS,
  LIVE_SWEEP_JUDGE_MAX_TOKENS,
  meanCentroid,
  orgHashOf,
  resolveAgentClusterThreshold,
  withDeliveryGuard,
  type WorkerHandler,
} from './handlers.js';
import {
  LEARNING_PERIOD_DAILY_CAP_USD,
  LEARNING_SPAN_NAME,
  LEARNING_SUITE_CAP,
  parseSampledMessages,
  resolveEvalJudge,
  rubricFor,
} from './learning-period.js';
import { perCallRequestLogSink, reconcileMetering } from './spend-sink.js';

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
  /** G2 rung 3: adopted rows carried through the snapshot untouched, and
   * fresh groups dropped because an adopted workload already owns that
   * territory (centroid within the adopted row's own threshold). */
  adoptedPreserved: number;
  adoptedTwinsSkipped: number;
  /** G2 rung 2: workloads whose serving-vs-incumbent measurement landed. */
  measured: number;
  measurementSkipped: Array<{ id: string; why: string }>;
  spendUsd: number;
  workloads: Array<{ orgId: string; id: string; parentCluster: string; sampleCount: number; cohesion: number }>;
}

/** workloads:discover — one org when named, else every org with spans. */
export const workloadsDiscoverHandler: WorkerHandler<'workloads:discover', WorkloadsDiscoverResult> = async (payload, ctx) => {
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
  const result: WorkloadsDiscoverResult = { orgs: 0, samplesSeen: 0, discovered: 0, noiseSamples: 0, adoptedPreserved: 0, adoptedTwinsSkipped: 0, measured: 0, measurementSkipped: [], spendUsd: 0, workloads: [] };

  for (const orgId of orgIds) {
    await withDeliveryGuard('workloads:discover', ctx, orgId, async () => {
      const rows = await ctx.db
        .select({ traceId: traceSpans.traceId, attrs: traceSpans.attrs })
        .from(traceSpans)
        .where(and(eq(traceSpans.orgId, orgId), eq(traceSpans.name, LEARNING_SPAN_NAME), gt(traceSpans.ts, since)));
      const samples: DiscoverySample[] = [];
      // Measurable item inputs per sample (the learning derivation's exact
      // gates: tool/part-carrying spans cluster but cannot be replayed).
      const itemInputs = new Map<string, { prompt: ChatMessage[]; reference: string }>();
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
        const completion = typeof a['gen_ai.completion'] === 'string' ? a['gen_ai.completion'] : null;
        const toolCount = typeof a['potion.tool_count'] === 'number' ? a['potion.tool_count'] : 0;
        const partCount = typeof a['potion.multimodal_parts'] === 'number' ? a['potion.multimodal_parts'] : 0;
        const legacy = typeof a['gen_ai.prompt'] === 'string' ? a['gen_ai.prompt'] : null;
        const prompt: ChatMessage[] | null = full ?? (legacy !== null && legacy.length > 0 ? [{ role: 'user', content: legacy }] : null);
        if (completion !== null && prompt !== null && toolCount === 0 && partCount === 0) {
          itemInputs.set(r.traceId, { prompt, reference: completion });
        }
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

      // G2 rung 3: ADOPTED workloads are routing state — the snapshot keeps
      // them (replaceOrgWorkloads clears non-adopted only), fresh groups on
      // their territory are dropped (the adopted row IS that structure,
      // already routed on), and their ids stay reserved.
      const adopted = await listAdoptedWorkloads(ctx.db, orgId);
      result.adoptedPreserved += adopted.length;
      const survivors = groups.filter((g) => {
        const twin = adopted.find(
          (a) => a.parentCluster === g.parentCluster && cosineSim(g.centroid, a.centroid as number[]) >= a.threshold,
        );
        if (twin !== undefined) result.adoptedTwinsSkipped += 1;
        return twin === undefined;
      });

      const safe = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const takenIds = new Set(adopted.map((a) => a.id));
      const perParentCount = new Map<string, number>();
      const newRows: NewOrgWorkload[] = survivors.map((g) => {
        let n = (perParentCount.get(g.parentCluster) ?? 0) + 1;
        let id = `wl-${orgHashOf(orgId)}-${safe(g.parentCluster)}-${n}`;
        while (takenIds.has(id)) {
          n += 1;
          id = `wl-${orgHashOf(orgId)}-${safe(g.parentCluster)}-${n}`;
        }
        perParentCount.set(g.parentCluster, n);
        return {
          id,
          orgId,
          parentCluster: g.parentCluster,
          sampleCount: g.members.length,
          cohesion: g.cohesion,
          exemplarText: samples[g.exemplarIndex]!.text.slice(0, WORKLOAD_EXEMPLAR_CHARS),
          centroid: g.centroid,
          memberTraceIds: g.members.map((m) => samples[m]!.id),
          status: 'observed',
          threshold,
          windowDays: WORKLOAD_WINDOW_DAYS,
        };
      });
      await replaceOrgWorkloads(ctx.db, orgId, newRows);
      result.discovered += newRows.length;
      for (const r of newRows) {
        result.workloads.push({ orgId, id: r.id, parentCluster: r.parentCluster, sampleCount: r.sampleCount, cohesion: r.cohesion });
      }

      // ---- G2 RUNG 2: measure each discovered workload — the learning-
      // period recipe at WORKLOAD grain. The serving pick is what production
      // serves the PARENT today (one resolver); eval rows land at the
      // WORKLOAD id coordinate (org-scoped), so per-workload org frontiers
      // can aggregate them in the adoption rung. Shares the learning
      // period's daily spend cap; a workload the cap excludes keeps
      // measurement NULL with a named reason — never a fabricated number.
      if (newRows.length === 0) return;
      const { table: prices } = loadPrices(ctx.pricesPath);
      const { providerMode, judgeModelOverride } = resolveEvalJudge(prices);
      const key = await getFirstApiKeyWithPolicy(ctx.db, orgId);
      const boundConfig = key?.policyId ? ((await getPolicyById(ctx.db, orgId, key.policyId))?.config ?? null) : null;
      const parsedPolicy = boundConfig === null ? null : PolicySchema.safeParse(boundConfig);
      const orgPolicy: Policy = parsedPolicy?.success ? parsedPolicy.data : DEFAULT_ORG_POLICY;
      const inc = await getOrgIncumbents(ctx.db, orgId);
      const namedIncumbent = (inc?.models ?? []).find((m) => prices.entries.some((e) => e.alias === m));
      const decisionByParent = new Map<string, Awaited<ReturnType<typeof servingDecisionFor>>>();

      for (const w of newRows) {
        const items: Array<EvalItem & { sourceTraceId?: string }> = [];
        for (const traceId of w.memberTraceIds as string[]) {
          const input = itemInputs.get(traceId);
          if (input === undefined) continue; // tool/part-carrying member — not replayable
          items.push({
            id: traceId,
            clusterId: w.id,
            prompt: input.prompt,
            reference: input.reference,
            scoring: { kind: 'llm-judge', rubric: rubricFor(w.parentCluster), judgeModel: judgeModelOverride ?? 'mock-judge', scale: [0, 1] },
            sourceTraceId: traceId,
          });
        }
        if (items.length < WORKLOAD_MIN_SAMPLES) {
          result.measurementSkipped.push({ id: w.id, why: `${items.length} replayable items of ${WORKLOAD_MIN_SAMPLES} needed (tools/attachments excluded)` });
          continue;
        }
        let decision = decisionByParent.get(w.parentCluster);
        if (decision === undefined) {
          decision = await servingDecisionFor(ctx.db, { orgId, clusterId: w.parentCluster, policy: orgPolicy, providerMode, prices });
          decisionByParent.set(w.parentCluster, decision);
        }
        const frontier = decision.binding.frontier;
        const op = decision.op;
        const servingPoint = op.config !== null && frontier !== null ? frontier.points.find((pt) => pt.strategyHash === strategyHash(op.config!)) ?? null : null;
        if (servingPoint === null) {
          result.measurementSkipped.push({ id: w.id, why: 'serving is not a measured frontier point for the parent — nothing honest to measure against' });
          continue;
        }
        const incumbentModel = namedIncumbent ?? (frontier!.points
          .filter((pt) => pt.strategyConfig.type === 'single')
          .sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K)[0]?.strategyConfig as { model?: string } | undefined)?.model;
        if (incumbentModel === undefined) {
          result.measurementSkipped.push({ id: w.id, why: 'no reference model (no named incumbent, no single on the parent frontier)' });
          continue;
        }
        const spentToday = await learningSpendSince(ctx.db, orgId, new Date(Date.now() - 24 * 3600 * 1000));
        const remaining = LEARNING_PERIOD_DAILY_CAP_USD - spentToday;
        if (remaining <= 0.05) {
          result.measurementSkipped.push({ id: w.id, why: 'daily measurement cap reached' });
          continue;
        }
        // db-derived suites resolve by PREFIX in the harness (runner.ts:
        // agent-/learn-) — the learn- prefix keeps this zero-blast-radius.
        const suiteId = `learn-${w.id}-v1`;
        await upsertDerivedSuite(ctx.db, {
          suiteId,
          clusterId: w.id,
          orgId,
          manifest: {
            suiteId, clusterId: w.id, version: '1.0.0',
            source: { kind: 'authored', name: 'Potion workload measurement — discovered-workload members (redacted, under consent)', license: 'Proprietary (customer-derived, redacted)' },
            items: 'items.jsonl', scoring: { allowed: ['llm-judge'] }, createdAt: new Date().toISOString(),
          },
          items,
          itemCap: LEARNING_SUITE_CAP,
        });
        const loaded = await loadDerivedSuite(ctx.db, suiteId);
        if (loaded === null || loaded.items.length < WORKLOAD_MIN_SAMPLES) {
          result.measurementSkipped.push({ id: w.id, why: 'suite failed to derive' });
          continue;
        }
        const incumbentCfg = { type: 'single' as const, model: incumbentModel };
        const incumbentHash = strategyHash(incumbentCfg);
        const capUsd = Math.min(remaining, deriveSuiteVerifyCapUsd(loaded.items.length, 2));
        const meter = providerMode === 'live' ? perCallRequestLogSink(ctx.db, { orgId, clusterId: w.parentCluster, status: 'eval_live' }) : null;
        let summary;
        try {
          summary = await runEval(
            {
              suiteIds: [],
              suiteV2Ids: [suiteId],
              strategies: [servingPoint.strategyConfig, incumbentCfg],
              budgetCapUsd: capUsd,
              provider: providerMode,
              resume: true,
              orgId,
              ...(judgeModelOverride !== undefined ? { judgeModelOverride } : {}),
              ...(providerMode === 'live' ? { judgeMaxTokens: LIVE_SWEEP_JUDGE_MAX_TOKENS, maxOutputTokens: LIVE_SWEEP_ANSWER_MAX_TOKENS } : {}),
            },
            { db: ctx.dbHandle, pricesPath: ctx.pricesPath, prices, ...(meter !== null ? { spendSink: meter.sink } : {}) },
          );
        } catch (e) {
          result.measurementSkipped.push({ id: w.id, why: `run refused: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` });
          continue;
        }
        await ctx.db.insert(evalRuns).values({
          id: summary.runId,
          options: {
            suiteIds: [], suiteV2Ids: [suiteId], strategyHashes: [servingPoint.strategyHash, incumbentHash], agentCluster: w.id,
            purpose: 'workloads:measure',
            ...(meter !== null ? { metering: reconcileMetering(meter, summary, `workloads-measure ${w.id}`) } : {}),
          },
          budgetCapUsd: capUsd, provider: providerMode, status: 'completed', spendUsd: summary.spendUsd, orgId,
        });
        result.spendUsd += summary.spendUsd;
        const { pairs } = await pairedQualities(ctx.db, {
          clusterId: w.id, candidateHash: servingPoint.strategyHash, incumbentHash, pricesVersion: prices.version, providerMode, orgId,
          itemIds: loaded.items.map((i) => i.id),
        });
        const verdict = computeRetention(pairs, { seedKey: `workload|${orgId}|${w.id}|${suiteId}`, floor: DEFAULT_RETENTION_FLOOR });
        if (verdict.retention === null || verdict.insufficient !== null) {
          result.measurementSkipped.push({ id: w.id, why: `insufficient pairs: ${verdict.insufficient ?? 'none'}` });
          continue;
        }
        const servingQuality = pairs.reduce((s, pr) => s + pr.candidateQuality, 0) / pairs.length;
        const incumbentQuality = pairs.reduce((s, pr) => s + pr.incumbentQuality, 0) / pairs.length;
        const cfg = servingPoint.strategyConfig as { type: string; model?: string };
        await setWorkloadMeasurement(ctx.db, orgId, w.id, {
          servingModel: cfg.type === 'single' ? (cfg.model ?? 'single') : `combination (${cfg.type})`,
          servingQuality,
          incumbentModel,
          incumbentQuality,
          retention: verdict.retention,
          items: pairs.length,
          spendUsd: summary.spendUsd,
          measuredAt: new Date().toISOString(),
          runId: `wm-${randomUUID().slice(0, 8)}`,
        });
        result.measured += 1;
        // G2 rung 4: a measured workload is a decision waiting on a human —
        // it routes nothing until someone adopts it. Alert delivery must
        // never fail the measurement: the row is already the durable record.
        try {
          await emitAlertEvent(ctx, {
            orgId,
            event: 'evidence_ready',
            detail: {
              kind: 'workload_measured',
              workloadId: w.id,
              parentCluster: w.parentCluster,
              items: pairs.length,
              retention: verdict.retention,
              servingModel: cfg.type === 'single' ? (cfg.model ?? 'single') : `combination (${cfg.type})`,
              incumbentModel,
              narrative:
                `A kind of work inside '${w.parentCluster}' finished measuring on ${pairs.length} of your own ` +
                `requests: what serves it today keeps ${(verdict.retention.mean * 100).toFixed(1)}% of ` +
                `${incumbentModel}'s quality on that work. Route it separately, or leave it as it is — ` +
                `nothing changes until you say so.`,
            },
          });
        } catch {
          // swallowed: an alert fault must not undo a landed measurement
        }
      }
    });
  }
  return result;
};

// THE PROVIDER-DRIFT TRIPWIRE — the one clocked measurement (2026-09-11).
//
// The learning period measures on change: first measurement, frontier
// moved, enough new samples, a challenger. Every one of those is an INTERNAL
// event. None fires when the provider changes the model behind a fixed name
// — quantization, silent re-routing, a flaky host — and content-addressing
// makes that invisible by construction: the cell key is (strategy, item,
// prompt, scoring), so a swapped model is still a hit, and "a re-measure
// pays only for new items" means the old ones are never re-asked. A point
// that served at q 0.90 keeps re-verifying at 0.90 from cache while the live
// model is at 0.70.
//
// So: once a week, every served platform point is re-asked CANARY_SAMPLE_N
// fixed items (the runner takes the first N by item id — the same items
// every week) under a cache salt (the ISO week — never a hit; the
// Observatory's own design, 8489c89). A reading below the stored interval,
// widened by the canary's own binomial noise, is drift; better is never
// drift. On drift: that strategy's cells are retired (stale=true — and the
// runner now treats stale as a miss), and the learning period is enqueued
// so every org re-measures through the proposal path (trigger four). This
// is a TRIPWIRE, not a re-measurement: roughly $0.50/week fleet-wide, and
// the only thing in the measurement system that runs on a clock.
//
// DELIVERY, TWICE (2026-09-12, found on the first live run). The platform
// sweep this calls per cluster is itself guarded by withDeliveryGuard,
// keyed on ctx.delivery (the job id). Ten sweeps inside ONE job shared one
// claim: the first ran, the other nine replayed its recorded result — nine
// verdicts that were copies of agentic-tool-use's reading, five of them
// "ok" for models that were never asked. So: THIS handler takes the
// delivery guard (one claim per job, retries never double-spend), and each
// per-cluster sweep is called WITHOUT a delivery — the guard's own
// definition of a deliberate call, which runs unguarded. Idempotency is per
// (week, cluster): a week that crashed half-way resumes on the clusters it
// has not recorded, and a completed week is skipped whole.
import { randomUUID } from 'node:crypto';
import { getLatestFrontier, insertDriftCanary, listDriftCanariesForWeek, retireEvalResultsByStrategyHash } from '@potion/db';
import type { DriftCanaryPayload, FrontierPlatformSweepPayload } from './jobs.js';
import { frontierPlatformSweepHandler, PLATFORM_SUITE_BY_CLUSTER, withDeliveryGuard, type FrontierPlatformSweepResult, type JobContext } from './handlers.js';
import { CANARY_CAP_USD, CANARY_SAMPLE_N, canaryTarget, driftVerdict, isoWeek, type CanaryResult } from './observatory.js';

export interface DriftCanaryResult {
  week: string;
  ran: boolean;
  skipped?: string;
  canaries: CanaryResult[];
  /** `${clusterId}/${model}` for every drift detected this run. */
  drift: string[];
  /** Clusters already recorded this week and left alone. */
  alreadyRecorded: string[];
  cellsRetired: number;
  spendUsd: number;
}

/** What the tripwire reads from a sweep — narrow on purpose, so a test can
 * hand it a plain object and the type checks it against something real. */
export type CanarySweepReading = Pick<FrontierPlatformSweepResult, 'published' | 'sampled' | 'spendUsd'>;

/** Seams for tests: the sweep and the clock. Production uses the real ones. */
export interface DriftCanaryDeps {
  sweep: (payload: FrontierPlatformSweepPayload, ctx: JobContext) => Promise<CanarySweepReading>;
  now: () => Date;
}

export function createDriftCanaryHandler(deps: DriftCanaryDeps) {
  return async function driftCanary(payload: DriftCanaryPayload, ctx: JobContext): Promise<DriftCanaryResult> {
    return withDeliveryGuard('drift:canary', ctx, undefined, () => runDriftCanary(payload, ctx, deps));
  };
}

async function runDriftCanary(payload: DriftCanaryPayload, ctx: JobContext, deps: DriftCanaryDeps): Promise<DriftCanaryResult> {
  const week = payload.week ?? isoWeek(deps.now());
  const recorded = new Set((await listDriftCanariesForWeek(ctx.db, week)).map((r) => r.clusterId));
  const clusters = Object.keys(PLATFORM_SUITE_BY_CLUSTER).sort();
  const todo = payload.force === true ? clusters : clusters.filter((c) => !recorded.has(c));
  const alreadyRecorded = clusters.filter((c) => recorded.has(c));
  if (todo.length === 0) {
    return { week, ran: false, skipped: 'every cluster is already recorded this week', canaries: [], drift: [], alreadyRecorded, cellsRetired: 0, spendUsd: 0 };
  }
  // The per-cluster sweep runs as a DELIBERATE call: no delivery, no shared
  // claim. This job's own claim (above) is what makes a retry safe.
  const sweepCtx: JobContext = { ...ctx, delivery: undefined };
  const canaries: CanaryResult[] = [];
  const drift: string[] = [];
  let cellsRetired = 0;
  let spendUsd = 0;
  let attempted = 0;
  for (const clusterId of todo) {
    const frontier = await getLatestFrontier(ctx.db, clusterId, null);
    const target = frontier ? canaryTarget(frontier.points) : null;
    if (!frontier || !target) continue; // nothing served on this kind of work yet — nothing to watch, nothing recorded
    attempted += 1;
    const model = (target.strategyConfig as { model?: string }).model;
    const base = {
      clusterId,
      model: model ?? `composite:${target.strategyHash.slice(0, 8)}`,
      strategyHash: target.strategyHash,
      storedQuality: target.quality,
      storedCi95: target.evidence?.qualityCi95 ?? 0,
    };
    if (!model) {
      // a composite is canaried through its stages when they serve singly
      const row: CanaryResult = { ...base, observedMean: null, n: 0, verdict: 'inconclusive', spendUsd: 0, error: 'composite routed pick — not canaried' };
      canaries.push(row);
      await insertDriftCanary(ctx.db, { id: `dc-${randomUUID().slice(0, 8)}`, week, ...row, error: row.error ?? null, cellsRetired: 0 });
      continue;
    }
    try {
      const res = await deps.sweep(
        { clusterId, capUsd: CANARY_CAP_USD, maxAnswerers: 1, auditionModels: [model], sampleN: CANARY_SAMPLE_N, publish: false, cacheSalt: week },
        sweepCtx,
      );
      if (res.published) throw new Error(`INVARIANT: a canary published a frontier on ${clusterId} — publish:false is broken`);
      const sample = (res.sampled ?? []).find((x) => x.strategyHash === target.strategyHash) ?? null;
      const n = sample?.n ?? 0;
      const verdict = sample
        ? driftVerdict({ quality: target.quality, qualityCi95: target.evidence?.qualityCi95 ?? 0 }, { meanQuality: sample.meanQuality, n })
        : { verdict: 'inconclusive' as const, lowerBound: Number.NaN };
      let retired = 0;
      if (verdict.verdict === 'drift') {
        retired = await retireEvalResultsByStrategyHash(ctx.db, target.strategyHash);
        cellsRetired += retired;
        drift.push(`${clusterId}/${model}`);
      }
      const row: CanaryResult = {
        ...base,
        observedMean: sample?.meanQuality ?? null,
        n,
        verdict: verdict.verdict,
        spendUsd: res.spendUsd,
        ...(sample === null ? { error: `the sweep sampled ${(res.sampled ?? []).length} strategies, none with the target hash` } : {}),
      };
      canaries.push(row);
      spendUsd += res.spendUsd;
      await insertDriftCanary(ctx.db, { id: `dc-${randomUUID().slice(0, 8)}`, week, ...row, error: row.error ?? null, cellsRetired: retired });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      const row: CanaryResult = { ...base, observedMean: null, n: 0, verdict: 'inconclusive', spendUsd: 0, error };
      canaries.push(row);
      await insertDriftCanary(ctx.db, { id: `dc-${randomUUID().slice(0, 8)}`, week, ...row, error, cellsRetired: 0 });
    }
  }
  if (drift.length > 0) {
    // trigger four: every org re-measures through the proposal path; the
    // learning period's own trigger reads drift_canaries for the hashes it
    // serves, so an org whose points did not drift is skipped as unchanged.
    void ctx.queue?.enqueue('learning:period', {}).catch(() => undefined);
  }
  if (attempted === 0) {
    return { week, ran: false, skipped: 'every served cluster is already recorded this week', canaries: [], drift: [], alreadyRecorded, cellsRetired: 0, spendUsd: 0 };
  }
  return { week, ran: true, canaries, drift, alreadyRecorded, cellsRetired, spendUsd };
}

export const driftCanaryHandler = createDriftCanaryHandler({ sweep: frontierPlatformSweepHandler, now: () => new Date() });

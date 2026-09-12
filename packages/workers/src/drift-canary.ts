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
// Idempotent per ISO week: the server enqueues it weekly and again shortly
// after boot; a week that already has rows is skipped unless `force`.
import { randomUUID } from 'node:crypto';
import { getLatestFrontier, insertDriftCanary, retireEvalResultsByStrategyHash, weekHasDriftCanaries } from '@potion/db';
import type { DriftCanaryPayload } from './jobs.js';
import { frontierPlatformSweepHandler, PLATFORM_SUITE_BY_CLUSTER, type JobContext } from './handlers.js';
import { CANARY_CAP_USD, CANARY_SAMPLE_N, canaryTarget, driftVerdict, isoWeek, type CanaryResult } from './observatory.js';

export interface DriftCanaryResult {
  week: string;
  ran: boolean;
  skipped?: string;
  canaries: CanaryResult[];
  /** `${clusterId}/${model}` for every drift detected this run. */
  drift: string[];
  cellsRetired: number;
  spendUsd: number;
}

export async function driftCanaryHandler(payload: DriftCanaryPayload, ctx: JobContext): Promise<DriftCanaryResult> {
  const week = payload.week ?? isoWeek(new Date());
  if (payload.force !== true && (await weekHasDriftCanaries(ctx.db, week))) {
    return { week, ran: false, skipped: 'already ran this week', canaries: [], drift: [], cellsRetired: 0, spendUsd: 0 };
  }
  const canaries: CanaryResult[] = [];
  const drift: string[] = [];
  let cellsRetired = 0;
  let spendUsd = 0;
  for (const clusterId of Object.keys(PLATFORM_SUITE_BY_CLUSTER).sort()) {
    const frontier = await getLatestFrontier(ctx.db, clusterId, null);
    const target = frontier ? canaryTarget(frontier.points) : null;
    if (!frontier || !target) continue; // nothing served on this kind of work yet
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
      const res = await frontierPlatformSweepHandler(
        { clusterId, capUsd: CANARY_CAP_USD, maxAnswerers: 1, auditionModels: [model], sampleN: CANARY_SAMPLE_N, publish: false, cacheSalt: week },
        ctx,
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
      const row: CanaryResult = { ...base, observedMean: sample?.meanQuality ?? null, n, verdict: verdict.verdict, spendUsd: res.spendUsd };
      canaries.push(row);
      spendUsd += res.spendUsd;
      await insertDriftCanary(ctx.db, { id: `dc-${randomUUID().slice(0, 8)}`, week, ...row, error: null, cellsRetired: retired });
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
  return { week, ran: true, canaries, drift, cellsRetired, spendUsd };
}

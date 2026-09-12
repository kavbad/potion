// THE LEARNING PERIOD — the audit that starts itself (operator, 2026-08-22).
//
// For every org that named what it uses today AND agreed to sampling:
//   1. derive suites from the sampled requests (the existing traces:cluster
//      path — the sampler writes spans it already reads);
//   2. for each kind of work with enough items and no fresh proposal, run
//      the incumbent and the org's current serving pick on THEIR prompts
//      (the guarantee verifier's exact recipe: runEval, pairedQualities,
//      computeRetention), under a per-org daily cap billed to the org;
//   3. write a PROPOSAL: the incumbent's quality on their work, the serving
//      pick's retention against it, the floor Potion suggests, the saving.
// Never applies anything. The dashboard's one button does that.
import { budgetExhaustedReason, measurementBudgetFor } from './measurement-budget.js';
import { randomUUID } from 'node:crypto';
import { PolicySchema, strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import {
  DEFAULT_ORG_POLICY,
  clusterShadowEvidence,
  orgShadowEvidenceInputs,
  servingDecisionFor,
  type ShadowChallenger,
} from '@potion/pareto';
import {
  evalRuns,
  getFirstApiKeyWithPolicy,
  getOrgIncumbents,
  getPolicyById,
  getStrategyConfigs,
  insertChallengerProposal,
  insertLearningProposal,
  latestChallengerProposalsByCluster,
  latestProposalsByCluster,
  latestDriftAmong,
  listLearningProposals,
  listOrgIdsWithSpans,
  loadDerivedSuite,
  pairedQualities,
  traceSpans,
  upsertDerivedSuite,
} from '@potion/db';
import { and, eq } from 'drizzle-orm';
import type { ChatMessage, EvalItem } from '@potion/core';
import { runEval, type RunSummary } from '@potion/harness';
import { ENV_VAR_BY_PROVIDER, loadPrices } from '@potion/providers';
import { buildRegistry, classRepresentative } from '@potion/researcher';
import type { ProviderId, ProviderMode } from '@potion/core';
import {
  computeRetention,
  DEFAULT_RETENTION_FLOOR,
  deriveSuiteVerifyCapUsd,
  emitAlertEvent,
  LIVE_SWEEP_ANSWER_MAX_TOKENS,
  LIVE_SWEEP_JUDGE_MAX_TOKENS,
  PLATFORM_SUITE_BY_CLUSTER,
  withDeliveryGuard,
  type JobContext,
  type WorkerHandler,
} from './handlers.js';
import { perCallRequestLogSink, reconcileMetering } from './spend-sink.js';

export const LEARNING_PERIOD_MIN_ITEMS = 8;
export { LEARNING_PERIOD_DAILY_CAP_USD } from './measurement-budget.js';
/** Challenger proposals only: a fresh challenger proposal is not re-minted
 * inside this window. Bar proposals no longer refresh on a clock — see
 * measurementTrigger. */
export const LEARNING_PERIOD_REFRESH_DAYS = 7;

/**
 * WHEN TO RE-MEASURE A KIND OF WORK (2026-09-11: "isn't there an initial
 * measurement phase?"). There was not: every cluster with enough samples
 * was re-measured whenever its last proposal was older than seven days,
 * applied or not, on the same samples, forever — summarization for one org
 * was measured on Aug 29 and again on Sep 6 to reproduce the same 0.378.
 * A measurement is worth paying for when something it depends on changed:
 *   · no proposal yet (the first measurement is the learning period);
 *   · the frontier it measured against has moved (its version differs —
 *     a bar set against last month's points may now be unreachable or
 *     loose);
 *   · enough samples arrived after the proposal to be worth a run — at
 *     least LEARNING_RETRIGGER_MIN_NEW_SAMPLES, so a trickle of one prompt
 *     per six hours does not re-run the judge on the same suite every time
 *     (only the new cells cost anything under content-addressed resume,
 *     but each run still pays the judge on every new cell);
 *   · a shadow-qualified challenger appeared (it rides this run to prove
 *     itself beside the serving pick);
 *   · PROVIDER DRIFT (trigger four, drift-canary.ts): the weekly tripwire
 *     found the point this cluster serves or measures against reading
 *     below its stored interval on salted items. Every trigger above is an
 *     internal event; this is the only one that can see the provider change
 *     the model behind a fixed name — and content-addressed cells cannot,
 *     so the tripwire also retired that model's cells before enqueueing us.
 * Otherwise the last proposal still describes the world, and re-running
 * would spend judge money to learn nothing. A proposal written before
 * frontier versions were recorded (NULL) is re-measured once, then tracked.
 * Returns the reason to measure, or null when nothing changed.
 */
export const LEARNING_RETRIGGER_MIN_NEW_SAMPLES = 8;

/** Earlier looks at a cluster since its last APPLIED proposal — the
 * repeated-look half of the comparison family. Rows are newest-first. */
export function looksSinceLastApplied(rows: ReadonlyArray<{ clusterId: string; status: string }>, clusterId: string): number {
  let looks = 0;
  for (const r of rows) {
    if (r.clusterId !== clusterId) continue;
    if (r.status === 'applied') break;
    looks += 1;
  }
  return looks;
}

export function measurementTrigger(
  prev: { createdAt: Date; frontierVersion: number | null } | undefined,
  cur: {
    frontierVersion: number;
    sampleTs: readonly Date[];
    challengerQualified: boolean;
    /** The latest drift detection on the points this cluster serves or
     * measures against, if any (drift_canaries, verdict 'drift'). */
    drift?: { detectedAt: Date; model: string } | null;
  },
): string | null {
  if (prev === undefined) return 'first measurement';
  if (prev.frontierVersion === null) return 'previous proposal predates frontier tracking';
  if (prev.frontierVersion !== cur.frontierVersion) return `frontier moved v${prev.frontierVersion} → v${cur.frontierVersion}`;
  if (cur.drift && cur.drift.detectedAt > prev.createdAt) return `provider drift on ${cur.drift.model} (tripwire ${cur.drift.detectedAt.toISOString().slice(0, 10)})`;
  const fresh = cur.sampleTs.filter((t) => t > prev.createdAt).length;
  if (fresh >= LEARNING_RETRIGGER_MIN_NEW_SAMPLES) return `${fresh} new samples since the last proposal`;
  if (cur.challengerQualified) return 'a challenger qualified';
  return null;
}

export interface LearningPeriodOrgReport {
  orgId: string;
  outcome: 'no-incumbent' | 'no-consent' | 'incumbent-unpriced' | 'no-suites' | 'ran';
  proposals: { clusterId: string; id: string; suggestedFloor: number; spendUsd: number }[];
  /** G1: shadow-qualified challengers that ALSO held suite retention against
   * the serving route — minted as challenger_proposals rows. */
  challengers: { clusterId: string; id: string; challengerModel: string }[];
  skipped: { clusterId: string; why: string }[];
  spendUsd: number;
}

function singleCfg(model: string): StrategyConfig {
  return { type: 'single', model } as StrategyConfig;
}

function pointLabel(p: FrontierPoint): string {
  const c = p.strategyConfig as { type: string; model?: string };
  return c.type === 'single' ? (c.model ?? 'single') : `combination (${c.type})`;
}

/** The eval provider mode + live judge both measurement legs share (the
 * learning period and per-workload measurement) — one resolution, refusing
 * BEFORE any spend when live has no reachable judge. */
export function resolveEvalJudge(prices: { entries: Array<{ alias: string; provider: string }> }): {
  providerMode: ProviderMode;
  judgeModelOverride: string | undefined;
} {
  const providerMode: ProviderMode = process.env.POTION_EVAL_PROVIDER === 'live' ? 'live' : 'mock';
  let judgeModelOverride: string | undefined;
  if (providerMode === 'live') {
    const reachable = (p: string): boolean => p !== 'mock' && process.env[ENV_VAR_BY_PROVIDER[p as Exclude<ProviderId, 'mock'>]] !== undefined;
    const judge = classRepresentative(buildRegistry(prices as never).filter((e) => reachable(e.provider)), 'judge');
    if (!judge) throw new Error('measurement refused: no reachable live judge — no spend occurred');
    judgeModelOverride = judge.alias;
  }
  return { providerMode, judgeModelOverride };
}

export const LEARNING_SPAN_NAME = 'potion.learning.sample';
export const LEARNING_SUITE_CAP = 40;

export function learningSuiteId(orgId: string, clusterId: string): string {
  // the harness accepts [a-z0-9-]+ only; org ids may carry underscores
  const safe = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `learn-${safe(orgId)}-${safe(clusterId)}-v1`;
}

export function rubricFor(clusterId: string): string {
  return (
    `Score how well the ANSWER accomplishes the USER'S REQUEST for this kind of work (${clusterId}), using the REFERENCE as a guide to what a good answer contains. ` +
    'Reward correctness, completeness and following the request exactly; penalise errors, omissions and padding. ' +
    'The reference is one acceptable answer, not the only one: a different correct answer scores as high. 0 = useless, 1 = fully acceptable.'
  );
}

/** A sampled span's messages array, strictly validated — anything else
 * falls back to the legacy last-user-turn capture. */
export function parseSampledMessages(v: unknown): ChatMessage[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const m of v) {
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (
      (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') ||
      typeof content !== 'string'
    ) {
      return null;
    }
    out.push({ role, content });
  }
  return out;
}

/**
 * Build (or extend) one derived suite per kind of work from the sampled
 * spans the serving path kept under consent.
 *
 * FULL-REQUEST items (2026-09-01, G1 — external review §7): a span captured
 * with `potion.messages` contributes the WHOLE served conversation (system
 * + prior turns + last user) as the item's prompt — the measured task is
 * the served task. Legacy spans (last-user-turn only) still derive, as the
 * lesser capture they are. Spans whose request carried TOOLS or MULTIMODAL
 * PARTS are EXCLUDED and counted: the replay cannot execute the customer's
 * tools or see their attachments, and measuring the text-only remainder
 * would measure a different task. (Known follow-up: excluded spans still
 * occupy the per-cluster sampling cap.)
 */
export async function deriveLearningSuites(
  ctx: JobContext,
  orgId: string,
  judgeModel: string,
): Promise<{ sizes: Record<string, number>; excluded: Record<string, number>; sampleTs: Record<string, Date[]> }> {
  const rows = await ctx.db
    .select({ traceId: traceSpans.traceId, attrs: traceSpans.attrs, ts: traceSpans.ts })
    .from(traceSpans)
    .where(and(eq(traceSpans.orgId, orgId), eq(traceSpans.name, LEARNING_SPAN_NAME)));
  const byCluster = new Map<string, Array<EvalItem & { sourceTraceId?: string }>>();
  const excluded: Record<string, number> = {};
  // every usable sample's timestamp per cluster — the change trigger's "did
  // the suite grow, and by enough"
  const sampleTs: Record<string, Date[]> = {};
  for (const r of rows) {
    const a = r.attrs as Record<string, unknown>;
    const clusterId = typeof a['potion.cluster_id'] === 'string' ? a['potion.cluster_id'] : null;
    const completion = typeof a['gen_ai.completion'] === 'string' ? a['gen_ai.completion'] : null;
    if (!clusterId || !completion) continue;
    const ts = r.ts instanceof Date ? r.ts : new Date(r.ts as unknown as string);
    if (!Number.isNaN(ts.getTime())) (sampleTs[clusterId] ??= []).push(ts);
    const toolCount = typeof a['potion.tool_count'] === 'number' ? a['potion.tool_count'] : 0;
    const partCount = typeof a['potion.multimodal_parts'] === 'number' ? a['potion.multimodal_parts'] : 0;
    if (toolCount > 0 || partCount > 0) {
      excluded[clusterId] = (excluded[clusterId] ?? 0) + 1;
      continue;
    }
    const full = parseSampledMessages(a['potion.messages']);
    const legacy = typeof a['gen_ai.prompt'] === 'string' ? a['gen_ai.prompt'] : null;
    const prompt: ChatMessage[] | null = full ?? (legacy !== null && legacy.length > 0 ? [{ role: 'user', content: legacy }] : null);
    if (prompt === null) continue;
    const list = byCluster.get(clusterId) ?? [];
    list.push({
      id: r.traceId,
      clusterId,
      prompt,
      reference: completion,
      scoring: { kind: 'llm-judge', rubric: rubricFor(clusterId), judgeModel, scale: [0, 1] },
      sourceTraceId: r.traceId,
    });
    byCluster.set(clusterId, list);
  }
  const sizes: Record<string, number> = {};
  for (const [clusterId, items] of byCluster) {
    const suiteId = learningSuiteId(orgId, clusterId);
    await upsertDerivedSuite(ctx.db, {
      suiteId,
      clusterId,
      orgId,
      manifest: {
        suiteId, clusterId, version: '1.0.0',
        source: { kind: 'authored', name: 'Potion learning period — sampled requests under consent (redacted)', license: 'Proprietary (customer-derived, redacted)' },
        items: 'items.jsonl', scoring: { allowed: ['llm-judge'] }, createdAt: new Date().toISOString(),
      },
      items,
      itemCap: LEARNING_SUITE_CAP,
    });
    const loaded = await loadDerivedSuite(ctx.db, suiteId);
    sizes[clusterId] = loaded?.items.length ?? 0;
  }
  return { sizes, excluded, sampleTs };
}

export async function runLearningPeriodForOrg(ctx: JobContext, orgId: string, now = new Date()): Promise<LearningPeriodOrgReport> {
  const report: LearningPeriodOrgReport = { orgId, outcome: 'ran', proposals: [], challengers: [], skipped: [], spendUsd: 0 };
  const inc = await getOrgIncumbents(ctx.db, orgId);
  if (!inc || (inc.models.length === 0 && !inc.other)) return { ...report, outcome: 'no-incumbent' };
  if (!inc.samplingConsent) return { ...report, outcome: 'no-consent' };
  const { table: prices } = loadPrices(ctx.pricesPath);
  // GREENFIELD FALLBACK (2026-08-24, operator's from-scratch question): an
  // org with consent but NO priced named incumbent — building from scratch,
  // or "several / not sure" — used to dead-end here with samples
  // accumulating and the progress card promising "measuring" forever. Now
  // the reference becomes, per cluster, the frontier's top-quality SINGLE:
  // "what you'd otherwise use by default" — the same premium counterfactual
  // every receipt already prices. It is a real, priced model measured on
  // THEIR prompts, so the proposal reads identically either way.
  const namedIncumbent = inc.models.find((m) => prices.entries.some((e) => e.alias === m));

  const { providerMode, judgeModelOverride } = resolveEvalJudge(prices);

  // 1. suites from what was sampled, one per kind of work
  const { sizes, excluded, sampleTs } = await deriveLearningSuites(ctx, orgId, judgeModelOverride ?? 'mock-judge');
  // Excluded samples are named, never hidden: tool/attachment-carrying
  // requests were captured as metadata but cannot be replayed faithfully.
  for (const [clusterId, n] of Object.entries(excluded)) {
    report.skipped.push({ clusterId, why: `${n} sampled request${n === 1 ? '' : 's'} carry tools or attachments — not yet measurable` });
  }

  const fresh = new Date(now.getTime() - LEARNING_PERIOD_REFRESH_DAYS * 24 * 3600 * 1000);
  const existing = await latestProposalsByCluster(ctx.db, orgId);
  const priorProposals = await listLearningProposals(ctx.db, orgId, 200);
  let suites = 0;

  // The org's bound policy — the same anchor the learning routes bind floors
  // to (getFirstApiKeyWithPolicy: the earliest LIVE customer key), parsed;
  // absent or unparseable → DEFAULT_ORG_POLICY, exactly what any key would
  // have been minted with (keys.ts / the first-run reveal use the same
  // constant, so no surface drifts).
  const key = await getFirstApiKeyWithPolicy(ctx.db, orgId);
  const boundConfig = key?.policyId ? ((await getPolicyById(ctx.db, orgId, key.policyId))?.config ?? null) : null;
  const parsedPolicy = boundConfig === null ? null : PolicySchema.safeParse(boundConfig);
  const orgPolicy: Policy = parsedPolicy?.success ? parsedPolicy.data : DEFAULT_ORG_POLICY;

  // G1 CHALLENGER LEG inputs: the shadow plane's qualified challengers (if
  // any) ride the same suite run as the serving pick — measured beside it on
  // the org's own items, one instrument. One window read per org.
  const shadowInputs = await orgShadowEvidenceInputs(ctx.db, orgId, now);
  const challengerExisting = await latestChallengerProposalsByCluster(ctx.db, orgId);

  for (const clusterId of Object.keys(PLATFORM_SUITE_BY_CLUSTER).sort()) {
    const prev = existing.get(clusterId);
    if (!(clusterId in sizes)) continue;
    const suiteId = learningSuiteId(orgId, clusterId);
    const loaded = await loadDerivedSuite(ctx.db, suiteId);
    if (!loaded) continue;
    suites += 1;
    if (loaded.items.length < LEARNING_PERIOD_MIN_ITEMS) { report.skipped.push({ clusterId, why: `${loaded.items.length} of ${LEARNING_PERIOD_MIN_ITEMS} prompts` }); continue; }

    // the org's current serving pick for this kind of work — THE serve
    // chain itself (2026-08-31, one-resolver P0: external review found the
    // old reimplementation here — "top-level floor → cheapest above" —
    // ignored cluster floors, mishandled max_quality/latency policies,
    // skipped the provenance guard, and INVERTED the infeasible fallback:
    // cheapest, where production serves highest-quality. The route it
    // measured could be one production never serves.)
    const decision = await servingDecisionFor(ctx.db, { orgId, clusterId, policy: orgPolicy, providerMode, prices });
    const frontier = decision.binding.frontier;
    if (!frontier || frontier.points.length === 0) {
      report.skipped.push({ clusterId, why: decision.provenance === 'blocked' ? 'frontier blocked by the provenance guard' : 'no frontier' });
      continue;
    }
    // The measurement reference: the named incumbent when one is priced,
    // else the greenfield fallback (top-quality single on this frontier).
    const topSingle = frontier.points
      .filter((p) => p.strategyConfig.type === 'single')
      .sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K)[0];
    const incumbentModel = namedIncumbent ?? (topSingle?.strategyConfig as { model?: string } | undefined)?.model;
    if (!incumbentModel) { report.skipped.push({ clusterId, why: 'no reference model (no named incumbent, no single on the frontier)' }); continue; }
    const incumbentCfg = singleCfg(incumbentModel);
    const incumbentHash = strategyHash(incumbentCfg);
    const op = decision.op;
    if (op.config === null) { report.skipped.push({ clusterId, why: 'no route resolvable for this provider mode' }); continue; }
    const servingPickHash = strategyHash(op.config);
    const serving = frontier.points.find((p) => p.strategyHash === servingPickHash) ?? null;
    if (!serving) {
      // The route production would serve is a last-resort fallback config,
      // not a measured frontier point — there is no priced measurement to
      // compare against, so say that rather than measure a different route.
      report.skipped.push({ clusterId, why: `serving is the ${op.fallbackReason ?? 'fallback'} route — not a measured frontier point` });
      continue;
    }

    // G1 CHALLENGER LEG: a shadow-QUALIFIED challenger (lower bound ≥ the
    // cluster floor on ≥30 live requests, cheaper on measured actuals)
    // joins the run so the suite measures it BESIDE the serving pick — the
    // same items, the same judge, one instrument. Fresh challenger
    // proposals are not re-measured (the same refresh window as bars).
    const clusterFloor =
      decision.clusterPolicy.type === 'min_cost' || decision.clusterPolicy.type === 'compound'
        ? decision.clusterPolicy.qualityFloor
        : null;
    const shadowEv = clusterShadowEvidence(shadowInputs, { clusterId, servingHash: serving.strategyHash, clusterFloor });
    const qualified = shadowEv?.challengers.find((c) => c.qualifies) ?? null;
    const prevChallenger = challengerExisting.get(clusterId);
    let challenger: { hash: string; config: StrategyConfig; shadow: ShadowChallenger } | null = null;
    if (qualified !== null && !(prevChallenger !== undefined && prevChallenger.createdAt > fresh)) {
      const cfg =
        frontier.points.find((p) => p.strategyHash === qualified.strategyHash)?.strategyConfig ??
        (await getStrategyConfigs(ctx.db, [qualified.strategyHash]))[0]?.config;
      if (cfg !== undefined) challenger = { hash: qualified.strategyHash, config: cfg, shadow: qualified };
      else report.skipped.push({ clusterId, why: `challenger ${qualified.strategyHash.slice(0, 8)} has no resolvable config — skipped` });
    }

    // MEASURE ON CHANGE, not on a clock (measurementTrigger above).
    const drift = await latestDriftAmong(ctx.db, [serving.strategyHash, incumbentHash], prev?.createdAt ?? new Date(0));
    const trigger = measurementTrigger(
      prev === undefined ? undefined : { createdAt: prev.createdAt, frontierVersion: prev.frontierVersion ?? null },
      { frontierVersion: frontier.version, sampleTs: sampleTs[clusterId] ?? [], challengerQualified: challenger !== null, drift },
    );
    if (trigger === null) { report.skipped.push({ clusterId, why: `unchanged since the last proposal (frontier v${frontier.version}, fewer than ${LEARNING_RETRIGGER_MIN_NEW_SAMPLES} new samples, no challenger, no drift)` }); continue; }

    // THE COMPARISON FAMILY this run's verdicts belong to (P1-1, extended
    // to the learning period 2026-09-11). Every re-measure that can change
    // what serves is a test; a trigger every eight samples is a REPEATED
    // look. The family = the strategies tested beside the reference in this
    // run (serving vs incumbent; the challenger vs serving) + the earlier
    // looks at this cluster since its last APPLIED promotion. computeRetention
    // widens the interval by 1/family; the lower-bound law then tests the
    // widened bound, so the gate gets deafer as looks accumulate — a trigger
    // may update the estimate and drop losers, promotion still clears a
    // corrected bound at the suite's pre-registered n.
    const comparisons = (challenger !== null ? 2 : 1) + looksSinceLastApplied(priorProposals, clusterId);

    // THE BUDGET (2026-09-11: covered by Potion, so bounded like cost of
    // goods): a daily cap and a monthly ceiling sized to the org's serving
    // spend, both read from the request log where the money lands.
    const budget = await measurementBudgetFor(ctx.db, orgId, now);
    if (budget.exhausted !== null) { report.skipped.push({ clusterId, why: budgetExhaustedReason(budget) }); continue; }
    const capUsd = Math.min(budget.remainingUsd, deriveSuiteVerifyCapUsd(loaded.items.length, challenger !== null ? 3 : 2));

    const meter = providerMode === 'live' ? perCallRequestLogSink(ctx.db, { orgId, clusterId, status: 'eval_live' }) : null;
    let summary: RunSummary;
    try {
      summary = await runEval(
        {
          suiteIds: [],
          suiteV2Ids: [suiteId],
          strategies: [serving.strategyConfig, incumbentCfg, ...(challenger !== null ? [challenger.config] : [])],
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
      report.skipped.push({ clusterId, why: `run refused: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` });
      continue;
    }
    await ctx.db.insert(evalRuns).values({
      id: summary.runId,
      options: {
        suiteIds: [], suiteV2Ids: [suiteId], strategyHashes: [serving.strategyHash, incumbentHash, ...(challenger !== null ? [challenger.hash] : [])], agentCluster: clusterId,
        purpose: 'learning:period',
        ...(meter !== null ? { metering: reconcileMetering(meter, summary, `learning-period ${clusterId}`) } : {}),
      },
      budgetCapUsd: capUsd, provider: providerMode, status: 'completed', spendUsd: summary.spendUsd, orgId,
    });

    // G1 CHALLENGER verdict: challenger vs the SERVING route, paired on the
    // same run's rows. Gated on the retention LOWER bound (the lower-bound
    // law) — a proposal is minted only when the challenger provably holds
    // the serving route's quality on the org's own items. Never applied
    // here: apply is one button, and it mints an ORG frontier so routing
    // changes through the measured field under selection, never by fiat.
    if (challenger !== null) {
      const { pairs: cPairs } = await pairedQualities(ctx.db, {
        clusterId, candidateHash: challenger.hash, incumbentHash: serving.strategyHash,
        pricesVersion: prices.version, providerMode, orgId, itemIds: loaded.items.map((i) => i.id),
      });
      const cVerdict = computeRetention(cPairs, { seedKey: `challenger|${orgId}|${clusterId}|${suiteId}`, floor: DEFAULT_RETENTION_FLOOR, comparisons });
      if (cVerdict.retention === null || cVerdict.insufficient !== null) {
        report.skipped.push({ clusterId, why: `challenger ${challenger.shadow.model}: insufficient pairs (${cVerdict.insufficient ?? 'none'})` });
      } else if (cVerdict.retention.ci95[0] < DEFAULT_RETENTION_FLOOR) {
        report.skipped.push({
          clusterId,
          why: `challenger ${challenger.shadow.model}: retention lower bound ${cVerdict.retention.ci95[0].toFixed(3)} below ${DEFAULT_RETENTION_FLOOR} — not proposed`,
        });
      } else {
        const challengerQuality = cPairs.reduce((s, p) => s + p.candidateQuality, 0) / cPairs.length;
        const servingQualityOnSuite = cPairs.reduce((s, p) => s + p.incumbentQuality, 0) / cPairs.length;
        const cpId = `cp-${randomUUID().slice(0, 8)}`;
        await insertChallengerProposal(ctx.db, {
          id: cpId, orgId, clusterId, suiteId,
          servingHash: serving.strategyHash, servingModel: pointLabel(serving), servingQuality: servingQualityOnSuite,
          challengerHash: challenger.hash, challengerModel: challenger.shadow.model, challengerQuality,
          retention: cVerdict.retention,
          shadow: {
            n: challenger.shadow.n, quality: challenger.shadow.quality, qualityCi: challenger.shadow.qualityCi,
            costPer1K: challenger.shadow.costPer1K,
            servingMeasuredCostPer1K: shadowEv?.servingMeasuredCostPer1K ?? null,
            windowDays: shadowEv?.windowDays ?? null, reason: challenger.shadow.reason,
          },
          items: cPairs.length, spendUsd: 0, status: 'proposed',
        });
        report.challengers.push({ clusterId, id: cpId, challengerModel: challenger.shadow.model });
        // G2 rung 4: a proved challenger is inert until someone promotes it.
        // Alert delivery must never fail the learning period — the proposal
        // row is already the durable record.
        try {
          await emitAlertEvent(ctx, {
            orgId,
            event: 'evidence_ready',
            detail: {
              kind: 'challenger_proposed',
              proposalId: cpId,
              clusterId,
              challengerModel: challenger.shadow.model,
              servingModel: pointLabel(serving),
              retention: cVerdict.retention,
              items: cPairs.length,
              narrative:
                `On your own '${clusterId}' traffic, ${challenger.shadow.model} held ` +
                `${(cVerdict.retention.mean * 100).toFixed(1)}% of what ${pointLabel(serving)} scores ` +
                `(lower bound ${(cVerdict.retention.ci95[0] * 100).toFixed(1)}%, ${cPairs.length} paired items) ` +
                `for less. Promoting builds a router from your measurements; your quality floor still decides ` +
                `what serves.`,
            },
          });
        } catch {
          // swallowed: an alert fault must not undo a landed proposal
        }
      }
    }

    const { pairs } = await pairedQualities(ctx.db, {
      clusterId, candidateHash: serving.strategyHash, incumbentHash, pricesVersion: prices.version, providerMode, orgId,
      itemIds: loaded.items.map((i) => i.id),
    });
    const { retention, insufficient } = computeRetention(pairs, { seedKey: `learning-period|${orgId}|${clusterId}|${suiteId}`, floor: DEFAULT_RETENTION_FLOOR, comparisons });
    if (!retention || insufficient) { report.skipped.push({ clusterId, why: `insufficient pairs: ${insufficient ?? 'none'}` }); report.spendUsd += summary.spendUsd; continue; }
    const incumbentQuality = pairs.reduce((s, p) => s + p.incumbentQuality, 0) / pairs.length;
    const servingQuality = pairs.reduce((s, p) => s + p.candidateQuality, 0) / pairs.length;
    const incumbentPoint = frontier.points.find((p) => p.strategyHash === incumbentHash) ?? null;
    const incumbentCostPer1K = incumbentPoint?.costPer1K ?? null;
    const projectedSaving = incumbentCostPer1K && incumbentCostPer1K > 0 ? Math.max(0, 1 - serving.costPer1K / incumbentCostPer1K) : null;
    // The bar IS the measurement (2026-08-31 fix): the floor's meaning is
    // "never worse than what your current model measures on your own work",
    // so it derives from incumbentQuality and NOTHING else. The old
    // Math.max(0.5, …) clamp silently proposed bars the incumbent itself
    // failed while the card claimed the number was measured — the
    // caption-vs-provenance class of lie, eradicated. A near-zero
    // measurement is an instrument or sampling problem, not a bar: skip
    // with a typed reason rather than invent a number.
    const suggestedFloor = suggestedFloorFor(incumbentQuality);
    if (suggestedFloor === null) {
      report.skipped.push({ clusterId, why: `incumbent measured ${incumbentQuality.toFixed(3)} — near zero; check the instrument/sampling before proposing a bar` });
      report.spendUsd += summary.spendUsd;
      continue;
    }
    const id = `lp-${randomUUID().slice(0, 8)}`;
    await insertLearningProposal(ctx.db, {
      id, orgId, clusterId, suiteId,
      incumbentModel, incumbentHash, incumbentQuality, incumbentCostPer1K,
      servingHash: serving.strategyHash, servingModel: pointLabel(serving), servingQuality, servingCostPer1K: serving.costPer1K,
      retention, suggestedFloor, projectedSaving, items: pairs.length, spendUsd: summary.spendUsd, status: 'proposed',
      frontierVersion: frontier.version,
      pricesVersion: prices.version,
    });
    report.proposals.push({ clusterId, id, suggestedFloor, spendUsd: summary.spendUsd });
    report.spendUsd += summary.spendUsd;
  }
  if (suites === 0) return { ...report, outcome: 'no-suites' };
  return report;
}

/** The bar derivation, pure and pinned (2026-08-31): the proposed floor IS
 * the incumbent's measured quality, floored to 2dp — never a typed-in
 * minimum (the old Math.max(0.5,…) clamp proposed bars the incumbent
 * itself failed while the card claimed measurement). null = near-zero
 * measurement: an instrument/sampling problem, not a bar. */
export function suggestedFloorFor(incumbentQuality: number): number | null {
  const floor = Math.min(1, Math.floor(incumbentQuality * 100) / 100);
  return floor < 0.05 ? null : floor;
}

/** learning:period — one org when named, else every org with sampled spans. */
export const learningPeriodHandler: WorkerHandler<'learning:period'> = async (payload, ctx) => {
  const orgIds = payload.orgId ? [payload.orgId] : await listOrgIdsWithSpans(ctx.db, new Date(Date.now() - 30 * 24 * 3600 * 1000));
  const reports: LearningPeriodOrgReport[] = [];
  for (const orgId of orgIds) {
    reports.push(await withDeliveryGuard('learning:period', ctx, orgId, () => runLearningPeriodForOrg(ctx, orgId)));
    // G2 rung 1: the same fresh samples the period measured also refresh
    // the org's discovered-structure snapshot (fire-and-forget).
    void ctx.queue?.enqueue('workloads:discover', { orgId }).catch(() => undefined);
  }
  return { orgs: reports.length, reports };
};

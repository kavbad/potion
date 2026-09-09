// guarantee:suite-verify + suite:certify (G2.1) — the trust hierarchy's
// CONTRACTUAL leg, moved out of handlers.ts 2026-09-09.
//
// A PURE MOVE: not a line of logic changed. 1,108 lines of a 6,709-line file,
// and the most self-contained region in it.

import { BOOTSTRAP_RESAMPLES, bootstrapMeanCi, seedFromString, sha256,   type ProviderId, type StrategyConfig } from '@potion/core';
import { approvedRubricForCluster, certificationStateForCluster, claimJobExecution, completeJobExecution, derivedSuiteIdFor, insertSuiteCertificationTx, loadDerivedSuite, computeSuiteContentHash, evalRuns, activeIncumbent, getPolicyById, insertIncidentRow, insertGuaranteeVerdict, pairedQualities, resolveAdvisoryWithEvidence, resolveIncidentWithEvidence, resolveRollbackTarget, appendIncidentVerifyAttempt, getIncidentByIdForOrg, markRecoveryUnconfirmed, openContractualIncidentForTuple, strategyConfigs, type UnpairableItem } from '@potion/db';
import { getBudget, mtdSpendUsd } from '@potion/db';
import { BudgetCapError, runEval, type RunSummary } from '@potion/harness';
import { perCallRequestLogSink, reconcileMetering } from './spend-sink.js';
import { ENV_VAR_BY_PROVIDER } from '@potion/providers';
import { hasLiveEvidence } from '@potion/pareto';
import { buildRegistry, classRepresentative } from '@potion/researcher';
import { clusters } from '@potion/db';
import { type JobKind } from './jobs.js';
import { type GuaranteeSuiteVerifyPayload, type SuiteCertifyPayload } from './jobs.js';
import {  } from 'drizzle-orm';
import { type ProviderMode } from '@potion/core';
import {  eq } from 'drizzle-orm';
import {
  registryPrices, RECOVERY_UNCONFIRMED_AFTER, AGENT_SUITE_ITEM_CAP_V2,
  LIVE_SWEEP_ANSWER_MAX_TOKENS, LIVE_SWEEP_JUDGE_MAX_TOKENS,
  type JobContext, type WorkerHandler,
} from './handler-shared.js';
import { emitAlertEvent } from './alerts-job.js';

// G2.1 — guarantee:suite-verify: the trust hierarchy's CONTRACTUAL leg.
//
// The advisory serve leg only ever trips a wire; THIS job renders the
// verdict, by re-evaluating the serving strategy and the org's designated
// incumbent on the derived suite and measuring per-item retention
// r_i = serving_i / incumbent_i. Runs in the env's provider mode — mock
// deployments render mock-LABELED verdicts (providerMode is stamped on
// every verdict; modes structurally cannot mix in the pairing). Every
// non-verdict outcome is a RECORDED refusal — appended to the incident's
// durable verifyAttempts ledger (G2.2) — never a silent drop; the advisory
// stays open and the sweep's retry pass re-enqueues the verify.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SUITE_VERIFY_CAP_USD = 5;
/**
 * Per-(item × strategy) budget slice for the DERIVED default cap
 * (post-capstone item 2). Empirical: capstone leg 5b metered $1.1045 over
 * 23 items × 2 strategies ≈ $0.024/cell at the live ceilings; $0.03 gives
 * ~25% headroom. A step-level suite (184 items × 2 strategies → ~$11) blows
 * the flat $5 default by design — the default must scale with the suite or
 * every step-suite verify would be refused by its own preflight. An explicit
 * payload capUsd always wins; the fail-closed budget pre-check and the
 * projection preflight are unchanged and still bind.
 */
export const SUITE_VERIFY_CAP_PER_CELL_USD = 0.03;
export function deriveSuiteVerifyCapUsd(itemCount: number, strategies = 2): number {
  return Math.max(DEFAULT_SUITE_VERIFY_CAP_USD, itemCount * strategies * SUITE_VERIFY_CAP_PER_CELL_USD);
}
/** Items where the incumbent itself scores below this are EXCLUDED from
 * retention (smoothing would fabricate retention on items the baseline
 * fails); the exclusion count is always reported. */
export const SUITE_VERIFY_EPSILON = 0.05;
export const DEFAULT_RETENTION_FLOOR = 0.9;
/** Minimum usable pairs for a verdict (mirrors GUARANTEE_MIN_SAMPLES). */
export const SUITE_VERIFY_MIN_PAIRS = 5;

/** One item's contribution to a retention verdict (G2.8-followup). */
export interface RetentionPairEvidence {
  itemId: string;
  candidateQuality: number;
  incumbentQuality: number;
  ratio: number;
}

export interface SuiteVerifyRetention {
  mean: number;
  ci95: [number, number];
  seed: number;
  resamples: number;
  pairs: number;
  excludedPairs: number;
  epsilon: number;
  floor: number;
  /** The per-item evidence, ordered by itemId. A verdict without this cannot
   * be diffed against another verdict, which is how G2.8's contradiction
   * became unexplainable. */
  pairEvidence: RetentionPairEvidence[];
}

/**
 * Pure retention arithmetic (unit-testable): epsilon exclusion → guards →
 * seeded bootstrap over per-item ratios. Returns either the retention
 * block or the insufficiency reason — never both, never neither.
 */
export function computeRetention(
  pairs: Array<{ itemId: string; candidateQuality: number; incumbentQuality: number }>,
  opts: { seedKey: string; floor: number; epsilon?: number; minPairs?: number },
): { retention: SuiteVerifyRetention | null; insufficient: string | null } {
  const epsilon = opts.epsilon ?? SUITE_VERIFY_EPSILON;
  const minPairs = opts.minPairs ?? SUITE_VERIFY_MIN_PAIRS;
  const usable = pairs.filter((p) => p.incumbentQuality >= epsilon);
  const excludedPairs = pairs.length - usable.length;
  if (usable.length < minPairs || excludedPairs > pairs.length / 2) {
    return {
      retention: null,
      insufficient: `${usable.length} usable pairs (${excludedPairs} excluded below epsilon ${epsilon}) — need ${minPairs}+ with a usable majority`,
    };
  }
  // G2.8-followup: SORT BY ITEM ID before doing anything order-sensitive.
  //
  // Two order dependencies lived here, and both reached a contractual number:
  //   1. the seed was `sha256(JSON.stringify(ratios))` over the ratio array in
  //      whatever order the rows arrived, so a different scan order produced a
  //      different seed and therefore a different CI95;
  //   2. `bootstrapMeanCi` draws `values[floor(rand()*n)]`, so even with a
  //      fixed seed the resamples land on different items when the array is
  //      permuted — the mean is order-invariant, the INTERVAL is not.
  // Sorting by itemId makes the pair sequence a function of the pair SET.
  // (`pairedQualities` now also orders in SQL; this is the belt to that
  // braces, because computeRetention is exported and unit-tested directly with
  // caller-supplied arrays.)
  const ordered = [...usable].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const ratios = ordered.map((p) => p.candidateQuality / p.incumbentQuality);
  // Seed from the item-keyed pair CONTENT, not from the bare ratio array: two
  // different pairings can produce the same multiset of ratios, and they are
  // not the same evidence.
  const seedBody = ordered
    .map((p) => `${p.itemId}:${p.candidateQuality}/${p.incumbentQuality}`)
    .join('|');
  const seed = seedFromString(`${opts.seedKey}|${ordered.length}|${sha256(seedBody)}`);
  const { mean, ci95 } = bootstrapMeanCi(ratios, seed, BOOTSTRAP_RESAMPLES);
  return {
    retention: {
      mean,
      ci95: ci95 as [number, number],
      seed,
      resamples: BOOTSTRAP_RESAMPLES,
      pairs: ordered.length,
      excludedPairs,
      epsilon,
      floor: opts.floor,
      // The per-item evidence behind this number, ordered. Without it a later
      // disagreement between two verdicts is undiagnosable — which is exactly
      // the position G2.8 ended in.
      pairEvidence: ordered.map((p) => ({
        itemId: p.itemId,
        candidateQuality: p.candidateQuality,
        incumbentQuality: p.incumbentQuality,
        ratio: p.candidateQuality / p.incumbentQuality,
      })),
    },
    insufficient: null,
  };
}

export interface GuaranteeSuiteVerifyResult {
  /** The durable guarantee_verdicts row this run wrote (0029). Null never
   * happens in practice — the write is load-bearing — but the field is
   * nullable so pre-0029 stored job results still parse. */
  verdictId: string | null;
  outcome:
    | 'contractual-breach'
    | 'all-clear'
    | 'self-incumbent'
    | 'no-incumbent'
    | 'incumbent-unresolvable'
    | 'no-suite'
    | 'insufficient-pairs'
    | 'budget-refused'
    /** Post-capstone item 1 guard: a MOCK verify against a cluster that holds
     * LIVE evidence is a false-live event — the leg-5c defect (env unset →
     * silent mock degrade → 1.0645 "all-clear" on a live contract). Refused
     * and recorded, never stamped-and-proceeded. */
    | 'mode-mismatch';
  providerMode: ProviderMode;
  runId: string | null;
  spendUsd: number;
  retention: SuiteVerifyRetention | null;
  /** The contractual incident this verdict lands on. On a DEDUPED breach
   * (an unresolved contractual incident already covers the tuple — G2.2)
   * this is the EXISTING incident's id and no new row/alert is produced. */
  verdictIncidentId: string | null;
  advisoryResolved: boolean;
  /** G2.2 auto-restore: the rollback incident lifted on CONFIDENT recovery
   * (retention CI95 lower ≥ floor); null otherwise. */
  restoredIncidentId: string | null;
  /** G2.2: 'guarantee_recovery_unconfirmed' escalated this run (Nth
   * consecutive non-confident all-clear on a restore verify). */
  recoveryUnconfirmed: boolean;
  detail: string | null;
  /** Post-capstone item 3 (Decision 2, owner-selected full gating): when the
   * suite is UNCERTIFIED the verdict is still measured and durably recorded,
   * but contractual effects — incident open/dedupe, advisory resolution,
   * auto-restore, alert emission — are WITHHELD: an uncertified suite is one
   * the instrument declined to vouch for; letting it page a customer or roll
   * back traffic would act on evidence we won't publish. Absent on outcomes
   * with no contractual reach (refusals, self-incumbent identity). */
  contractualEffects?: 'applied' | 'withheld-uncertified';
}

/** Provenance the verdict row needs that the result shape never carried —
 * accumulated as the run learns it, so the ONE chokepoint write below has it
 * whatever the outcome. */
interface VerdictProvenance {
  incumbentHash: string | null;
  incumbentDesignationId: string | null;
  suiteId: string | null;
  suiteVersion: string | null;
  pricesVersion: string | null;
  rubricHash: string | null;
  calibrationId: string | null;
  unpairable: UnpairableItem[];
}

const runSuiteVerify = async (
  payload: GuaranteeSuiteVerifyPayload,
  ctx: JobContext,
  prov: VerdictProvenance,
): Promise<Omit<GuaranteeSuiteVerifyResult, 'verdictId'>> => {
  const providerMode: ProviderMode = process.env.POTION_EVAL_PROVIDER === 'live' ? 'live' : 'mock';
  const base = {
    providerMode,
    runId: null,
    spendUsd: 0,
    retention: null,
    verdictIncidentId: null,
    advisoryResolved: false,
    restoredIncidentId: null,
    recoveryUnconfirmed: false,
    detail: null,
  };

  // Ownership — misuse, not an outcome: throw.
  const clusterRows = await ctx.db.select().from(clusters).where(eq(clusters.id, payload.clusterId));
  const cluster = clusterRows[0];
  if (!cluster) throw new Error(`unknown cluster '${payload.clusterId}'`);
  if (cluster.orgId !== payload.orgId) {
    throw new Error(`cluster '${payload.clusterId}' does not belong to org '${payload.orgId}'`);
  }
  const policyRow = await getPolicyById(ctx.db, payload.orgId, payload.policyId);
  if (!policyRow) throw new Error(`unknown policy '${payload.policyId}' for org '${payload.orgId}'`);
  const guarantee = policyRow.config.guarantee;
  if (!guarantee) throw new Error(`policy '${payload.policyId}' carries no guarantee config`);

  // G2.2: fetch the attached incidents UP FRONT — org-ownership misuse
  // throws, and the advisory's db createdAt is the SLA clock the verdict's
  // notification binds ("clocks start at advisory creation").
  const advisoryRow = payload.advisoryIncidentId
    ? await getIncidentByIdForOrg(ctx.db, payload.orgId, payload.advisoryIncidentId)
    : null;
  if (payload.advisoryIncidentId && (!advisoryRow || advisoryRow.kind !== 'advisory')) {
    throw new Error(`advisory '${payload.advisoryIncidentId}' not found for org '${payload.orgId}'`);
  }
  const restoreRow = payload.restoreForIncidentId
    ? await getIncidentByIdForOrg(ctx.db, payload.orgId, payload.restoreForIncidentId)
    : null;
  if (payload.restoreForIncidentId && (!restoreRow || restoreRow.kind !== 'rollback')) {
    throw new Error(`rollback '${payload.restoreForIncidentId}' not found for org '${payload.orgId}'`);
  }
  // Every open-leaving outcome records a durable attempt on the attached
  // incident(s) — the row is the lifecycle ledger (starved verification is
  // visible evidence, never a lost job result).
  const recordAttempt = async (outcome: string, detail: string | null): Promise<void> => {
    const at = new Date().toISOString();
    if (payload.advisoryIncidentId) {
      await appendIncidentVerifyAttempt(ctx.db, payload.orgId, payload.advisoryIncidentId, { at, outcome, detail });
    }
    if (payload.restoreForIncidentId) {
      await appendIncidentVerifyAttempt(ctx.db, payload.orgId, payload.restoreForIncidentId, { at, outcome, detail });
    }
  };

  // Mode guard (post-capstone item 1, the companion to Decision 2's
  // suite-certification gate): a mock verify on a cluster with LIVE evidence
  // would render a mock verdict against a live contract — exactly the leg-5c
  // false-live event (POTION_EVAL_PROVIDER unset → silent degrade → mock
  // 1.0645 "all-clear" superseding a live 0.2707 breach). Certification
  // asserts the suite measures what the guarantee promises; this refusal is
  // its negative half — the instrument declines to measure a live contract in
  // mock mode. A RECORDED outcome, not a throw: the 0029 chokepoint makes the
  // refusal durable, recordAttempt keeps the advisory ledger honest, and the
  // advisory stays open for a correctly-configured retry. Mock-on-mock stays
  // fully allowed (the walkthrough world has no live evidence).
  if (providerMode === 'mock' && (await hasLiveEvidence(ctx.db, payload.clusterId, payload.orgId))) {
    const detail =
      `mode mismatch: cluster '${payload.clusterId}' holds LIVE evidence but this verify would run ` +
      'MOCK (POTION_EVAL_PROVIDER is not "live") — a mock verdict on a live-evidence cluster is a ' +
      'false-live event; re-run with POTION_EVAL_PROVIDER=live. No spend occurred.';
    await recordAttempt('mode-mismatch', detail);
    return { ...base, outcome: 'mode-mismatch', detail };
  }

  // Designation — recorded outcomes (the advisory stays open).
  const incumbent = await activeIncumbent(ctx.db, payload.orgId, payload.clusterId);
  if (!incumbent) {
    const detail = 'no active incumbent designation — designate one to enable retention verdicts';
    await recordAttempt('no-incumbent', detail);
    return { ...base, outcome: 'no-incumbent', detail };
  }
  prov.incumbentHash = incumbent.strategyHash;
  prov.incumbentDesignationId = incumbent.id;
  const loadCfg = async (hash: string): Promise<StrategyConfig | null> => {
    const rows = await ctx.db.select().from(strategyConfigs).where(eq(strategyConfigs.hash, hash));
    return rows[0]?.config ?? null;
  };
  const incumbentCfg = await loadCfg(incumbent.strategyHash);
  if (!incumbentCfg) {
    const detail = `incumbent strategy '${incumbent.strategyHash}' not in strategy_configs — re-designate`;
    await recordAttempt('incumbent-unresolvable', detail);
    return { ...base, outcome: 'incumbent-unresolvable', detail };
  }
  const servingCfg = await loadCfg(payload.servingStrategyHash);
  if (!servingCfg) {
    const detail = `serving strategy '${payload.servingStrategyHash}' not in strategy_configs`;
    await recordAttempt('incumbent-unresolvable', detail);
    return { ...base, outcome: 'incumbent-unresolvable', detail };
  }
  const floor = guarantee.retentionFloor ?? DEFAULT_RETENTION_FLOOR;

  // Serving the incumbent itself: retention is 1.0 by identity — all-clear
  // without spend (durable record on the advisory).
  if (payload.servingStrategyHash === incumbent.strategyHash) {
    let advisoryResolved = false;
    if (payload.advisoryIncidentId) {
      advisoryResolved =
        (await resolveAdvisoryWithEvidence(ctx.db, payload.orgId, payload.advisoryIncidentId, {
          verdict: 'all-clear',
          reason: 'self-incumbent',
          providerMode,
          floor,
        })) !== null;
    }
    // G2.2 auto-restore: retention 1.0 by identity IS confident recovery.
    let restoredIncidentId: string | null = null;
    if (payload.restoreForIncidentId && restoreRow) {
      const restored = await resolveIncidentWithEvidence(
        ctx.db, payload.orgId, payload.restoreForIncidentId, 'rollback',
        { resolvedBy: 'auto-restore', verdict: 'self-incumbent', providerMode, floor },
      );
      if (restored) {
        restoredIncidentId = restored.id;
        try {
          await emitAlertEvent(ctx, {
            orgId: payload.orgId,
            event: 'guarantee_restored',
            incidentId: restored.id,
            clockStartAt: restoreRow.createdAt.toISOString(),
            detail: { clusterId: payload.clusterId, fromStrategy: payload.servingStrategyHash, reason: 'self-incumbent', providerMode },
          });
        } catch {
          // resolution is the durable record
        }
      }
    }
    return { ...base, outcome: 'self-incumbent', advisoryResolved, restoredIncidentId, detail: 'serving strategy IS the incumbent — retention 1.0 by identity' };
  }

  const suiteId = await derivedSuiteIdFor(ctx.db, payload.clusterId);
  prov.suiteId = suiteId;
  const loaded = await loadDerivedSuite(ctx.db, suiteId);
  if (!loaded || loaded.items.length === 0) {
    const detail = `derived suite '${suiteId}' is empty — nothing to verify against`;
    await recordAttempt('no-suite', detail);
    return { ...base, outcome: 'no-suite', detail };
  }
  prov.suiteVersion = loaded.suite.version;
  // Default cap scales with the suite (step-level suites are ~8× larger);
  // explicit payload capUsd always wins.
  const capUsd = payload.capUsd ?? deriveSuiteVerifyCapUsd(loaded.items.length);

  // FAIL-CLOSED budget refusal (live spend only) — RECORDED durably on the
  // incident's ledger (G2.2 starved verification), no throw: the advisory
  // stays open, its SLA clock keeps running, and the sweep keeps retrying.
  if (providerMode === 'live') {
    const budget = await getBudget(ctx.db, payload.orgId);
    if (budget !== null && budget.hardStop) {
      const mtd = await mtdSpendUsd(ctx.db, payload.orgId, new Date());
      if (mtd + capUsd > budget.monthlyCapUsd) {
        const detail = `hard-stop budget would be exceeded (MTD $${mtd.toFixed(2)} + cap $${capUsd.toFixed(2)} > monthly $${budget.monthlyCapUsd.toFixed(2)}) — no spend occurred`;
        await recordAttempt('budget-refused', detail);
        return { ...base, outcome: 'budget-refused', detail };
      }
    }
  }

  const prices = await registryPrices(ctx);
  prov.pricesVersion = prices.version;
  let judgeModelOverride: string | undefined;
  if (providerMode === 'live') {
    // Live reachability — explicit refusal, never a silent drop (G1.7
    // live-leg finding: partial spend then ProviderAuthError).
    const reachable = (p: string): boolean =>
      p !== 'mock' &&
      process.env[ENV_VAR_BY_PROVIDER[p as Exclude<ProviderId, 'mock'>]] !== undefined;
    const registry = buildRegistry(prices).filter((e) => reachable(e.provider));
    const judgeEntry = classRepresentative(registry, 'judge');
    if (!judgeEntry) {
      throw new Error('suite-verify refused: no reachable live judge-class model (set OPENROUTER_API_KEY or peers) — no spend occurred');
    }
    judgeModelOverride = judgeEntry.alias;
  }

  // The paired re-eval: |org / mode-suffixed cache keys make the incumbent
  // leg cheap on repeat verifies (resume:true). Live spend meters PER CALL
  // as it occurs (post-capstone item 1) — the pre-0030 aggregate row billed
  // summary.spendUsd at completion, which is cache-INCLUSIVE: the filed
  // $1.1045 over-metering was THIS site re-billing a fully-cached re-verify.
  // Cache hits never reach a provider, so they meter zero by construction.
  const meter =
    providerMode === 'live'
      ? perCallRequestLogSink(ctx.db, {
          orgId: payload.orgId,
          clusterId: payload.clusterId,
          status: 'eval_live',
        })
      : null;
  const summary: RunSummary = await runEval(
    {
      suiteIds: [],
      suiteV2Ids: [suiteId],
      strategies: [servingCfg, incumbentCfg],
      budgetCapUsd: capUsd,
      provider: providerMode,
      resume: true,
      orgId: payload.orgId,
      ...(judgeModelOverride !== undefined ? { judgeModelOverride } : {}),
      ...(providerMode === 'live'
        ? { judgeMaxTokens: LIVE_SWEEP_JUDGE_MAX_TOKENS, maxOutputTokens: LIVE_SWEEP_ANSWER_MAX_TOKENS }
        : {}),
    },
    {
      db: ctx.dbHandle,
      pricesPath: ctx.pricesPath,
      prices,
      ...(meter !== null ? { spendSink: meter.sink } : {}),
    },
  );
  // Completion RECONCILES the per-call record — it never writes spend anew.
  await ctx.db.insert(evalRuns).values({
    id: summary.runId,
    options: {
      suiteIds: [],
      suiteV2Ids: [suiteId],
      strategyHashes: [payload.servingStrategyHash, incumbent.strategyHash],
      agentCluster: payload.clusterId,
      purpose: 'guarantee:suite-verify',
      ...(meter !== null
        ? { metering: reconcileMetering(meter, summary, `suite-verify ${payload.clusterId}`) }
        : {}),
    },
    budgetCapUsd: capUsd,
    provider: providerMode,
    status: 'completed',
    spendUsd: summary.spendUsd,
    orgId: payload.orgId,
  });
  const spent = { ...base, runId: summary.runId, spendUsd: summary.spendUsd };

  // Retention over identical items, mode-filtered pairing.
  const { pairs, unpairable } = await pairedQualities(ctx.db, {
    clusterId: payload.clusterId,
    candidateHash: payload.servingStrategyHash,
    incumbentHash: incumbent.strategyHash,
    pricesVersion: prices.version,
    providerMode,
    orgId: payload.orgId,
    // THE VERDICT IS MEASURED ON THE SUITE IT STAMPS. Without this roster the
    // pairing spans every generation the cluster has ever had (see
    // pairedQualities' doc): a v2 verdict was being computed over abandoned
    // v1 evidence, reporting more pairs than the suite has items.
    itemIds: loaded.items.map((i) => i.id),
  });
  prov.unpairable = unpairable;
  const computed = computeRetention(pairs, {
    seedKey:
      `suite-verify|${payload.orgId}|${payload.policyId}|${payload.clusterId}|` +
      `${payload.servingStrategyHash}|${incumbent.strategyHash}`,
    floor,
  });
  if (computed.retention === null) {
    await recordAttempt('insufficient-pairs', computed.insufficient);
    return { ...spent, outcome: 'insufficient-pairs', detail: computed.insufficient };
  }
  const retention = computed.retention;
  const { mean, ci95 } = retention;
  const approvedRubric = await approvedRubricForCluster(ctx.db, payload.clusterId);
  prov.rubricHash = approvedRubric?.rubricHash ?? null;
  prov.calibrationId = approvedRubric?.calibrationId ?? null;
  // The FULL evidence block — a verdict without provenance is a test
  // failure (owner rule: status + evidence, always).
  const evidence = {
    leg: 'suite',
    policyId: payload.policyId,
    clusterId: payload.clusterId,
    fromStrategy: payload.servingStrategyHash,
    retention,
    // G2.8-followup: COVERAGE, carried with the verdict. Items evaluated for
    // one strategy but not the other used to vanish inside pairedQualities, so
    // a verdict over a partial suite read exactly like one over a whole suite.
    // `retention.pairs` says what was measured; this says what was not.
    unpairableItems: unpairable,
    suiteId,
    suiteVersion: loaded.suite.version,
    ...(approvedRubric !== null
      ? {
          rubricHash: approvedRubric.rubricHash,
          ...(approvedRubric.calibrationId !== null ? { calibrationId: approvedRubric.calibrationId } : {}),
        }
      : {}),
    incumbent: { hash: incumbent.strategyHash, designationId: incumbent.id },
    runId: summary.runId,
    spendUsd: summary.spendUsd,
    providerMode,
    ...(payload.advisoryIncidentId !== undefined ? { advisoryIncidentId: payload.advisoryIncidentId } : {}),
  };

  // Certification gate (post-capstone item 3, Decision 2 — owner-selected
  // FULL scope): the verdict above is measured and will be durably recorded
  // by the chokepoint whatever happens next, but an UNCERTIFIED suite backs
  // no contractual claim — no incident, no advisory resolution, no
  // auto-restore, no alert. The withholding is itself a recorded outcome:
  // the attempt lands on any attached incident ledger and the verdict row's
  // detail names the reason, so a certified retry can pick the work up.
  // (The self-incumbent identity path above is deliberately ungated —
  // retention 1.0 by identity involves no suite instrument at all.)
  const certState = await certificationStateForCluster(ctx.db, payload.clusterId, payload.orgId);
  if (!certState.certified) {
    const measuredOutcome = ci95[1] < floor ? ('contractual-breach' as const) : ('all-clear' as const);
    const withheldDetail = `uncertified-suite: contractual effects withheld — ${certState.reason ?? 'suite not certified'}`;
    await recordAttempt(measuredOutcome, withheldDetail);
    return {
      ...spent,
      outcome: measuredOutcome,
      retention,
      detail: withheldDetail,
      contractualEffects: 'withheld-uncertified',
    };
  }

  // CONTRACTUAL verdict: breach iff the retention CI95 UPPER bound is
  // below the floor (confidently under, the G0.3 rigor).
  if (ci95[1] < floor) {
    await recordAttempt('contractual-breach', null);
    // G2.2 dedupe: while an unresolved contractual incident already covers
    // this tuple (incl. the active rollback a restore verify runs against),
    // sweep-driven retries must not mint a duplicate incident or alert —
    // the advisory still resolves, pointing at the EXISTING incident.
    const existing = await openContractualIncidentForTuple(ctx.db, {
      orgId: payload.orgId,
      policyId: payload.policyId,
      clusterId: payload.clusterId,
      fromStrategy: payload.servingStrategyHash,
    });
    if (existing) {
      let advisoryResolved = false;
      if (payload.advisoryIncidentId) {
        advisoryResolved =
          (await resolveAdvisoryWithEvidence(ctx.db, payload.orgId, payload.advisoryIncidentId, {
            verdict: 'contractual-breach',
            escalatedTo: existing.id,
            deduped: true,
            retention,
            providerMode,
          })) !== null;
      }
      return {
        ...spent,
        outcome: 'contractual-breach',
        retention,
        verdictIncidentId: existing.id,
        advisoryResolved,
        detail: 'deduped: an unresolved contractual incident already covers this tuple',
        contractualEffects: 'applied',
      };
    }
    let verdictIncident: { id: string; createdAt: Date };
    if (guarantee.action === 'rollback') {
      const target = await resolveRollbackTarget(ctx.db, {
        clusterId: payload.clusterId,
        policy: policyRow.config,
        fromStrategyHash: payload.servingStrategyHash,
      });
      verdictIncident = target
        ? await insertIncidentRow(ctx.db, {
            orgId: payload.orgId,
            kind: 'rollback',
            detail: {
              ...evidence,
              toStrategy: target.strategyHash,
              toFrontierVersion: target.frontierVersion,
              targetSource: target.source,
            },
          })
        : await insertIncidentRow(ctx.db, {
            orgId: payload.orgId,
            kind: 'quality_breach',
            detail: { ...evidence, intendedAction: 'rollback', reason: 'no-rollback-target' },
          });
    } else {
      verdictIncident = await insertIncidentRow(ctx.db, {
        orgId: payload.orgId,
        kind: 'quality_breach',
        detail: evidence,
      });
    }
    const verdictIncidentId = verdictIncident.id;
    let advisoryResolved = false;
    if (payload.advisoryIncidentId) {
      advisoryResolved =
        (await resolveAdvisoryWithEvidence(ctx.db, payload.orgId, payload.advisoryIncidentId, {
          verdict: 'contractual-breach',
          escalatedTo: verdictIncidentId,
          retention,
          providerMode,
        })) !== null;
    }
    try {
      await emitAlertEvent(ctx, {
        orgId: payload.orgId,
        event: guarantee.action === 'rollback' ? 'rollback' : 'quality_breach',
        // THE SLA BINDING lands here: the hierarchy path's notification
        // latency is measured from ADVISORY CREATION to this verdict's
        // delivered POST; a manual/no-advisory verify binds the verdict's
        // own createdAt.
        incidentId: verdictIncidentId,
        clockStartAt: (advisoryRow?.createdAt ?? verdictIncident.createdAt).toISOString(),
        detail: { incidentId: verdictIncidentId, clusterId: payload.clusterId, strategyHash: payload.servingStrategyHash, retention: mean, retentionCi95: ci95, floor },
      });
    } catch {
      // alert faults never fail the verdict — the incident is durable
    }
    return { ...spent, outcome: 'contractual-breach', retention, verdictIncidentId, advisoryResolved, contractualEffects: 'applied' };
  }

  // All-clear — durable record on the advisory (when one is attached).
  let advisoryResolved = false;
  if (payload.advisoryIncidentId) {
    advisoryResolved =
      (await resolveAdvisoryWithEvidence(ctx.db, payload.orgId, payload.advisoryIncidentId, {
        verdict: 'all-clear',
        retention,
        providerMode,
        evidence,
      })) !== null;
  }

  // G2.2 auto-restore: only CONFIDENT recovery lifts the rollback —
  // retention CI95 LOWER ≥ floor, the symmetric rigor of the breach test
  // (owner decision). A non-confident all-clear is recorded, never
  // restores, and after RECOVERY_UNCONFIRMED_AFTER consecutive ones
  // escalates 'guarantee_recovery_unconfirmed' for human review — the
  // uncertain zone is bounded in TIME, not outcome (owner refinement).
  let restoredIncidentId: string | null = null;
  let recoveryUnconfirmed = false;
  if (payload.restoreForIncidentId && restoreRow) {
    if (ci95[0] >= floor) {
      const restored = await resolveIncidentWithEvidence(
        ctx.db, payload.orgId, payload.restoreForIncidentId, 'rollback',
        { resolvedBy: 'auto-restore', verdict: 'confident-recovery', retention, providerMode, runId: summary.runId, floor },
      );
      if (restored) {
        restoredIncidentId = restored.id;
        try {
          await emitAlertEvent(ctx, {
            orgId: payload.orgId,
            event: 'guarantee_restored',
            incidentId: restored.id,
            clockStartAt: restoreRow.createdAt.toISOString(),
            detail: {
              clusterId: payload.clusterId,
              fromStrategy: payload.servingStrategyHash,
              toStrategy: (restoreRow.detail as Record<string, unknown>).toStrategy ?? null,
              retention,
              floor,
              providerMode,
            },
          });
        } catch {
          // the resolution row is the durable record
        }
      }
    } else {
      const appended = await appendIncidentVerifyAttempt(
        ctx.db, payload.orgId, payload.restoreForIncidentId,
        {
          at: new Date().toISOString(),
          outcome: 'all-clear-not-confident',
          detail: `retention CI95 lower ${ci95[0].toFixed(3)} < floor ${floor} — uncertainty never auto-restores`,
        },
      );
      // Trailing consecutive non-confident run (a confident restore or a
      // breach would have ended the rollback's open ledger by now).
      const attempts = Array.isArray((appended?.detail as Record<string, unknown> | undefined)?.verifyAttempts)
        ? ((appended!.detail as Record<string, unknown>).verifyAttempts as Array<{ outcome: string }>)
        : [];
      let run = 0;
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i]!.outcome === 'all-clear-not-confident') run += 1;
        else break;
      }
      if (run >= RECOVERY_UNCONFIRMED_AFTER) {
        const won = await markRecoveryUnconfirmed(ctx.db, payload.orgId, payload.restoreForIncidentId, {
          at: new Date().toISOString(),
          consecutiveNonConfident: run,
          floor,
        });
        if (won) {
          recoveryUnconfirmed = true;
          try {
            await emitAlertEvent(ctx, {
              orgId: payload.orgId,
              event: 'guarantee_recovery_unconfirmed',
              incidentId: payload.restoreForIncidentId,
              clockStartAt: restoreRow.createdAt.toISOString(),
              detail: {
                clusterId: payload.clusterId,
                fromStrategy: payload.servingStrategyHash,
                consecutiveNonConfident: run,
                retention,
                floor,
                providerMode,
                note: 'uncertainty never auto-restores and never silently persists — human review',
              },
            });
          } catch {
            // the CAS stamp is the durable record
          }
        }
      }
    }
  }
  return { ...spent, outcome: 'all-clear', retention, advisoryResolved, restoredIncidentId, recoveryUnconfirmed, contractualEffects: 'applied' };
};

/**
 * The exported handler is a CHOKEPOINT around runSuiteVerify (0029): one
 * durable guarantee_verdicts row per run, for EVERY outcome — all-clears
 * included. Pre-0029 an all-clear with no advisory attached wrote nothing,
 * which is why G2.8's contradictory 1.0645 verdict could never be
 * root-caused: the instrument recorded its failures and not its passes.
 *
 * A wrapper, not per-site calls, on purpose: seven return sites is seven
 * chances for the next edit to add an eighth that forgets to record — the
 * exact "handled in one route is not handled" class this repo keeps paying
 * for. Here a new outcome is durable by construction.
 *
 * The write is LOAD-BEARING (awaited, throws through): a verdict that cannot
 * be recorded must not report success. Ownership-misuse throws inside the
 * runner happen before any verdict exists and stay exceptions, not outcomes.
 */
export const guaranteeSuiteVerifyHandler: WorkerHandler<'guarantee:suite-verify', GuaranteeSuiteVerifyResult> = async (
  payload: GuaranteeSuiteVerifyPayload,
  ctx: JobContext,
): Promise<GuaranteeSuiteVerifyResult> =>
  withDeliveryGuard('guarantee:suite-verify', ctx, payload.orgId, async () => {
  const prov: VerdictProvenance = {
    incumbentHash: null,
    incumbentDesignationId: null,
    suiteId: null,
    suiteVersion: null,
    pricesVersion: null,
    rubricHash: null,
    calibrationId: null,
    unpairable: [],
  };
  const result = await runSuiteVerify(payload, ctx, prov);
  const verdictId = await insertGuaranteeVerdict(ctx.db, {
    orgId: payload.orgId,
    policyId: payload.policyId,
    clusterId: payload.clusterId,
    suiteId: prov.suiteId ?? (await derivedSuiteIdFor(ctx.db, payload.clusterId)),
    suiteVersion: prov.suiteVersion,
    candidateHash: payload.servingStrategyHash,
    incumbentHash: prov.incumbentHash,
    incumbentDesignationId: prov.incumbentDesignationId,
    providerMode: result.providerMode ?? 'unknown',
    pricesVersion: prov.pricesVersion,
    outcome: result.outcome,
    retention: result.retention as unknown as Record<string, unknown> | null,
    unpairable: prov.unpairable,
    detail: result.detail,
    runId: result.runId,
    spendUsd: result.spendUsd,
    rubricHash: prov.rubricHash,
    calibrationId: prov.calibrationId,
    advisoryIncidentId: payload.advisoryIncidentId ?? null,
    verdictIncidentId: result.verdictIncidentId,
  });
  return { ...result, verdictId };
  });

// ─────────────────────────────────────────────────────────────────────────────
// suite:certify (post-capstone item 3, Decision 2) — the suite-validity gate.
// A derived suite is certified for guarantee use only if the org's designated
// incumbent RETAINS ITS OWN BASELINE when fresh-re-evaluated against it: the
// items' references are recorded outputs of the incumbent's own sessions, so
// self-retention below the floor means the suite measures the instrument,
// not the strategy (the capstone's 0.2000). The re-eval is FRESH by
// construction — runEval without resume never reuses cached rows and never
// overwrites them; the metric is computed from summary.results IN MEMORY
// (reading back through the db would return stale cached qualities).
// Every outcome writes a durable suite_certifications row at the chokepoint
// wrapper; refusals are recorded rows (evidence.refused), never throws.
// ─────────────────────────────────────────────────────────────────────────────

/** = DEFAULT_RETENTION_FLOOR: if the incumbent cannot hit the contractual
 * floor against its OWN recorded outputs, a floor verdict rendered from that
 * suite is unfalsifiable — certification and the guarantee share the bar. */
export const CERTIFICATION_SELF_RETENTION_FLOOR = 0.9;

export interface SuiteCertifyResult {
  /** The durable suite_certifications row (write is load-bearing). */
  certificationId: string | null;
  status: 'certified' | 'failed';
  outcome:
    | 'certified'
    | 'not-certified'
    | 'no-suite'
    | 'no-incumbent'
    | 'budget-refused'
    | 'mode-mismatch';
  suiteId: string;
  suiteVersion: string | null;
  selfRetentionMean: number | null;
  providerMode: ProviderMode;
  runId: string | null;
  spendUsd: number;
  detail: string | null;
}

interface CertifyProvenance {
  suiteVersion: string | null;
  incumbentHash: string | null;
  incumbentDesignationId: string | null;
  evidence: Record<string, unknown>;
}

const runSuiteCertify = async (
  payload: SuiteCertifyPayload,
  ctx: JobContext,
  prov: CertifyProvenance,
): Promise<Omit<SuiteCertifyResult, 'certificationId' | 'status' | 'suiteVersion'>> => {
  const providerMode: ProviderMode = process.env.POTION_EVAL_PROVIDER === 'live' ? 'live' : 'mock';
  const base = { providerMode, runId: null, spendUsd: 0, selfRetentionMean: null, detail: null };

  // Ownership — misuse, not an outcome: throw (forged payloads die here).
  const clusterRows = await ctx.db.select().from(clusters).where(eq(clusters.id, payload.clusterId));
  const cluster = clusterRows[0];
  if (!cluster) throw new Error(`unknown cluster '${payload.clusterId}'`);
  if (cluster.orgId !== payload.orgId) {
    throw new Error(`cluster '${payload.clusterId}' does not belong to org '${payload.orgId}'`);
  }
  const suiteId = payload.suiteId ?? (await derivedSuiteIdFor(ctx.db, payload.clusterId));
  const loaded = await loadDerivedSuite(ctx.db, suiteId);
  if (payload.suiteId !== undefined && loaded !== null) {
    // An explicit suiteId (the comparability leg) must be the CLUSTER'S suite.
    if (loaded.suite.clusterId !== payload.clusterId || loaded.suite.orgId !== payload.orgId) {
      throw new Error(`suite '${suiteId}' does not belong to cluster '${payload.clusterId}'`);
    }
  }
  if (!loaded || loaded.items.length === 0) {
    return {
      ...base,
      suiteId,
      outcome: 'no-suite',
      detail: `derived suite '${suiteId}' is empty — nothing to certify against. No spend occurred.`,
    };
  }
  prov.suiteVersion = loaded.suite.version;

  // The item-1 guard, positive half: certifying a live-evidence cluster with
  // a mock instrument would stamp a false-live validity claim.
  if (providerMode === 'mock' && (await hasLiveEvidence(ctx.db, payload.clusterId, payload.orgId))) {
    return {
      ...base,
      suiteId,
      outcome: 'mode-mismatch',
      detail:
        `mode mismatch: cluster '${payload.clusterId}' holds LIVE evidence but this certification ` +
        'would run MOCK (POTION_EVAL_PROVIDER is not "live") — re-run with POTION_EVAL_PROVIDER=live. ' +
        'No spend occurred.',
    };
  }

  const incumbent = await activeIncumbent(ctx.db, payload.orgId, payload.clusterId);
  if (!incumbent) {
    return {
      ...base,
      suiteId,
      outcome: 'no-incumbent',
      detail: 'no active incumbent designation — certification measures the incumbent against its own outputs. No spend occurred.',
    };
  }
  prov.incumbentHash = incumbent.strategyHash;
  prov.incumbentDesignationId = incumbent.id;
  const cfgRows = await ctx.db
    .select()
    .from(strategyConfigs)
    .where(eq(strategyConfigs.hash, incumbent.strategyHash));
  const incumbentCfg = cfgRows[0]?.config;
  if (!incumbentCfg) {
    return {
      ...base,
      suiteId,
      outcome: 'no-incumbent',
      detail: `incumbent strategy '${incumbent.strategyHash}' not in strategy_configs — re-designate. No spend occurred.`,
    };
  }

  const capUsd = payload.capUsd ?? deriveSuiteVerifyCapUsd(loaded.items.length, 1);
  // FAIL-CLOSED budget refusal (live spend only) — recorded, never thrown.
  if (providerMode === 'live') {
    const budget = await getBudget(ctx.db, payload.orgId);
    if (budget !== null && budget.hardStop) {
      const mtd = await mtdSpendUsd(ctx.db, payload.orgId, new Date());
      if (mtd + capUsd > budget.monthlyCapUsd) {
        return {
          ...base,
          suiteId,
          outcome: 'budget-refused',
          detail: `hard-stop budget would be exceeded (MTD $${mtd.toFixed(2)} + cap $${capUsd.toFixed(2)} > monthly $${budget.monthlyCapUsd.toFixed(2)}) — no spend occurred`,
        };
      }
    }
  }

  const prices = await registryPrices(ctx);
  let judgeModelOverride: string | undefined;
  if (providerMode === 'live') {
    const reachable = (p: string): boolean =>
      p !== 'mock' &&
      process.env[ENV_VAR_BY_PROVIDER[p as Exclude<ProviderId, 'mock'>]] !== undefined;
    const registry = buildRegistry(prices).filter((e) => reachable(e.provider));
    const judgeEntry = classRepresentative(registry, 'judge');
    if (!judgeEntry) {
      throw new Error('suite:certify refused: no reachable live judge-class model — no spend occurred');
    }
    judgeModelOverride = judgeEntry.alias;
  }

  // FRESH re-eval of the incumbent only: no resume — cached rows are neither
  // reused nor overwritten; summary.results carries only fresh qualities.
  const meter =
    providerMode === 'live'
      ? perCallRequestLogSink(ctx.db, {
          orgId: payload.orgId,
          clusterId: payload.clusterId,
          status: 'eval_live',
        })
      : null;
  let summary: RunSummary;
  try {
    summary = await runEval(
      {
        suiteIds: [],
        suiteV2Ids: [suiteId],
        strategies: [incumbentCfg],
        budgetCapUsd: capUsd,
        provider: providerMode,
        orgId: payload.orgId,
        ...(judgeModelOverride !== undefined ? { judgeModelOverride } : {}),
        ...(providerMode === 'live'
          ? { judgeMaxTokens: LIVE_SWEEP_JUDGE_MAX_TOKENS, maxOutputTokens: LIVE_SWEEP_ANSWER_MAX_TOKENS }
          : {}),
      },
      {
        db: ctx.dbHandle,
        pricesPath: ctx.pricesPath,
      prices,
        ...(ctx.suitesV2Dir !== undefined ? { suitesV2Dir: ctx.suitesV2Dir } : {}),
        ...(meter !== null ? { spendSink: meter.sink } : {}),
      },
    );
  } catch (e) {
    if (e instanceof BudgetCapError) {
      return {
        ...base,
        suiteId,
        outcome: 'budget-refused',
        detail: `${e.message} (projection preflight) — no spend occurred`,
      };
    }
    throw e;
  }

  const metering = meter !== null ? reconcileMetering(meter, summary, `suite:certify ${suiteId}`) : null;
  await ctx.db.insert(evalRuns).values({
    id: summary.runId,
    options: {
      suiteIds: [],
      suiteV2Ids: [suiteId],
      strategyHashes: [incumbent.strategyHash],
      agentCluster: payload.clusterId,
      purpose: 'suite:certify',
      ...(metering !== null ? { metering } : {}),
    },
    budgetCapUsd: capUsd,
    provider: providerMode,
    status: 'completed',
    spendUsd: summary.spendUsd,
    orgId: payload.orgId,
  });

  // The metric, IN MEMORY from the fresh results.
  const qualities = summary.results.map((r) => ({ itemId: r.itemId, quality: r.quality }));
  const selfRetentionMean =
    qualities.length === 0
      ? 0
      : qualities.reduce((a, q) => a + q.quality, 0) / qualities.length;
  prov.evidence = {
    selfRetentionMean,
    floor: CERTIFICATION_SELF_RETENTION_FLOOR,
    items: loaded.items.length,
    executed: summary.executed,
    perItem: qualities.slice(0, AGENT_SUITE_ITEM_CAP_V2),
    providerMode: summary.providerMode,
    runId: summary.runId,
    suiteVersion: loaded.suite.version,
    ...(judgeModelOverride !== undefined ? { judgeModel: judgeModelOverride } : {}),
    executedSpendUsd: summary.executedSpendUsd,
    ...(metering !== null ? { metering } : {}),
  };
  const certified = selfRetentionMean >= CERTIFICATION_SELF_RETENTION_FLOOR;
  return {
    ...base,
    suiteId,
    outcome: certified ? 'certified' : 'not-certified',
    selfRetentionMean,
    runId: summary.runId,
    spendUsd: summary.executedSpendUsd,
    detail: certified
      ? `incumbent self-retention ${selfRetentionMean.toFixed(4)} ≥ floor ${CERTIFICATION_SELF_RETENTION_FLOOR} over ${summary.executed} items`
      : `incumbent self-retention ${selfRetentionMean.toFixed(4)} below floor ${CERTIFICATION_SELF_RETENTION_FLOOR} over ${summary.executed} items — the suite does not reproduce the incumbent's own baseline`,
  };
};

/** Chokepoint wrapper (the 0029 shape): EVERY outcome — certified, failed,
 * or refused — writes exactly one durable suite_certifications row. */
export const suiteCertifyHandler: WorkerHandler<'suite:certify', SuiteCertifyResult> = async (
  payload: SuiteCertifyPayload,
  ctx: JobContext,
): Promise<SuiteCertifyResult> =>
  withDeliveryGuard('suite:certify', ctx, payload.orgId, async () => {
  const prov: CertifyProvenance = {
    suiteVersion: null,
    incumbentHash: null,
    incumbentDesignationId: null,
    evidence: {},
  };
  const r = await runSuiteCertify(payload, ctx, prov);
  const measured = r.outcome === 'certified' || r.outcome === 'not-certified';
  const status: SuiteCertifyResult['status'] = r.outcome === 'certified' ? 'certified' : 'failed';
  const certificationId = await insertSuiteCertificationTx(ctx.db, {
    orgId: payload.orgId,
    clusterId: payload.clusterId,
    suiteId: r.suiteId,
    suiteVersion: prov.suiteVersion ?? 'unknown',
    // F7: record WHAT was certified, not just which version label it carried.
    // The gate recomputes this and refuses if the instrument has drifted; the
    // customer surface shows it so "certified" names something inspectable.
    suiteContentHash: await computeSuiteContentHash(ctx.db, r.suiteId),
    incumbentHash: prov.incumbentHash,
    incumbentDesignationId: prov.incumbentDesignationId,
    providerMode: r.providerMode,
    status,
    statusReason: measured
      ? r.outcome === 'certified'
        ? null
        : r.detail
      : `refused-${r.outcome}: ${r.detail ?? ''}`,
    evidence: measured ? prov.evidence : { refused: true, kind: r.outcome },
    spendUsd: r.spendUsd,
  });
  return { ...r, status, certificationId, suiteVersion: prov.suiteVersion };
  });

/**
 * F10 — the delivery guard for SPEND-BEARING and CONTRACT-BEARING handlers.
 *
 * Production retries every job 3× (SPEC §12.2) and BullMQ redelivers stalled
 * jobs after a worker crash regardless of the attempt limit. Nothing here was
 * idempotent: a throw AFTER runEval re-ran the whole handler — fresh provider
 * money, a fresh runId, a duplicate verdict row, and a second pass through
 * contractual branches whose preconditions had already been mutated (the
 * advisory now resolved, the rollback now restored, and the verifyAttempts
 * ledger inflated toward an EARLY recovery-unconfirmed escalation).
 *
 * Three delivery states, three answers:
 *   - first delivery      -> run
 *   - prior COMPLETED     -> replay its recorded result; run nothing
 *   - prior INCOMPLETE    -> REFUSE. Re-running would spend against an
 *                            attempt whose spend we cannot account for, and
 *                            the platform rule is that any doubt means no
 *                            spend. Recovery is a deliberate re-enqueue,
 *                            which mints a new job id.
 *
 * A handler invoked WITHOUT a delivery (tests, operator scripts) is by
 * definition a deliberate call and runs unguarded — two verdicts for one
 * tuple are correct when a human asked twice.
 */
export class JobRedeliveryRefusedError extends Error {
  constructor(
    readonly jobId: string,
    readonly jobKind: string,
  ) {
    super(
      `job '${jobId}' (${jobKind}) was already claimed by an attempt that did not complete — ` +
        'refusing to re-execute: a retry would spend against unaccounted prior spend. ' +
        're-enqueue deliberately to run it again',
    );
    this.name = 'JobRedeliveryRefusedError';
  }
}

export async function withDeliveryGuard<T>(
  kind: JobKind,
  ctx: JobContext,
  orgId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const delivery = ctx.delivery;
  if (!delivery) return run(); // direct call — deliberate by construction
  const claim = await claimJobExecution(ctx.db, {
    jobId: delivery.jobId,
    jobKind: kind,
    orgId,
    attempt: delivery.attempt,
  });
  if (claim.decision === 'already-completed') return claim.result as T;
  if (claim.decision === 'refuse-incomplete') {
    throw new JobRedeliveryRefusedError(delivery.jobId, kind);
  }
  const result = await run();
  await completeJobExecution(ctx.db, delivery.jobId, result);
  return result;
}



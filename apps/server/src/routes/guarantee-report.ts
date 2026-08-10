// Guarantee report (G2.1, trust hierarchy).
//
//   GET /api/reports/guarantee?from&to           GuaranteeReport JSON (org-scoped)
//   GET /api/reports/guarantee?period=YYYY-MM    same, month window (artifact parity)
//
// STANDING DECISIONS this surface implements (owner, 2026-08-07):
//   — the HEADLINE metric is BASELINE RETENTION: the serving strategy's
//     score relative to the org's designated incumbent on identical derived-
//     suite items. Raw scores are present in the drill-down, never first
//     (reference-anchored scales are workload-specific; absolutes mislead).
//   — floors derive from the incumbent's measured distribution, never
//     picked as absolute numbers.
//   — TRUST HIERARCHY: serve-leg floor crossings are ADVISORY; only
//     suite-verify evidence renders the contractual verdict. Incidents are
//     labeled by leg throughout.
// Every number ships with its provenance (status + evidence, always): the
// retention headline carries seed/ci/pairs/providerMode; the derived floor
// carries the full bootstrap provenance; undesignated clusters say
// "retention unavailable" rather than inventing a baseline.
import type { FastifyInstance } from 'fastify';
import type { Policy } from '@potion/core';
import {
  activeIncumbent,
  deriveServeFloor,
  distinctSampledTargets,
  GUARANTEE_MIN_SAMPLES,
  isDayString,
  listIncidents,
  listPoliciesWithGuarantee,
  qualitySeriesDaily,
  periodFromDay,
  periodToDay,
  isPeriodString,
  type ClusterIncumbentRow,
  type DerivedServeFloor,
  type IncidentRow,
  listPolicies,
  latestVerdictForTuple,
  tupleHasAnyVerdict,
  certificationStateForCluster,
  servedSpendByPolicyCluster,
  type GuaranteeVerdictRow,
} from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { GUARANTEE_VERIFY_SLA_MIN } from '@potion/workers';
import { bindServingLatency } from '../latency-policy.js';
import { openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import { confidenceFor, type Confidence } from './reports.js';
import { incidentDto, PLATFORM_RETENTION_FLOOR, type IncidentDto, type IncumbentDto } from './guarantee.js';
import { renderGuaranteeReportHtml } from '../billing/render-guarantee-html.js';

// ---- report contract ----

/** The headline: the LATEST suite-verify retention verdict for the tuple.
 * null = no verdict yet (report says so — never a fabricated number). */
export interface RetentionHeadline {
  verdict: 'all-clear' | 'contractual-breach';
  mean: number;
  ci95: [number, number];
  floor: number;
  pairs: number;
  excludedPairs: number;
  seed: number;
  confidence: Confidence;
  providerMode: string;
  /** When the verdict was rendered (incident created/resolved time). */
  at: string;
  /** The incident carrying the full evidence block. */
  incidentId: string;
}

/** G2.2: the tuple's verification state — starved verification is a NAMED
 * state on the report, never a silent "pending". */
export interface VerificationState {
  /** 'unverifiable' = an open advisory is escalated OR has aged past the
   * SLA bound (computed at REPORT time too, so the report never lags the
   * sweep); 'pending' = open advisory within bound; 'verified' = a
   * retention verdict exists and nothing is open; 'none' = no advisory
   * activity and no verdict. */
  state: 'verified' | 'pending' | 'unverifiable' | 'none';
  openAdvisoryAgeMin: number | null;
  verifyAttempts: number;
  lastAttempt: { at: string; outcome: string; detail: string | null } | null;
  escalatedAt: string | null;
  verifySlaMin: number;
}

export interface GuaranteeReportEntry {
  policyId: string;
  clusterId: string;
  /** HEADLINE (standing decision): baseline retention, never raw scores.
   * Post-capstone item 3: certification-GATED — an uncertified cluster
   * renders null + reason, never a number, even with a low badge. */
  retention: RetentionHeadline | null;
  /** Why retention is unavailable when null (visible rigor). */
  retentionUnavailableReason: string | null;
  /** Suite-certification state (Decision 2): the review-surface summary of
   * whether this cluster's suite is certified for guarantee use. Null for
   * non-agent clusters (certification governs derived agentic suites). */
  certification: {
    certified: boolean;
    selfRetentionMean: number | null;
    reason: string | null;
  } | null;
  /** G2.2 verification state (SLA clock runs from advisory creation). */
  verification: VerificationState;
  incumbent: IncumbentDto | null;
  /** Serve-leg advisory floor derived FRESH from the incumbent's serve
   * distribution (null with reason when underivable). */
  derivedFloor: {
    floor: number;
    provenance: NonNullable<DerivedServeFloor['provenance']>;
  } | null;
  /** Open serve-leg advisories: tripwires whose suite-verify is pending. */
  openAdvisories: IncidentDto[];
  /** All incidents for this tuple, labeled by leg ('serve' | 'suite' in
   * detail.leg; pre-G2.1 rows have no leg — labeled 'legacy'). */
  incidents: Array<IncidentDto & { leg: 'serve' | 'suite' | 'legacy' }>;
  /** Raw-score drill-down (present, never the headline): gap-filled daily
   * serve-path quality series. */
  qualitySeries: Array<{ day: string; mean: number | null; samples: number }>;
}

/**
 * The REALIZED latency premium for one compound policy over the period
 * (G2.6, owner decision 2: "fold the premium into the existing guarantee
 * report as a section — the month's realized latency premium in dollars,
 * alongside the nearest-feasible relaxation and its projected savings at the
 * same quality floor. The DTO serves the developer per-request; the report
 * serves the policy owner per-month — same computation, both surfaces.").
 *
 * Realized, not projected: `actualSpendUsd` is what the org actually paid on
 * served requests under this policy, and `unboundedSpendUsd` is what the
 * SAME volume would have cost on the strategy the bound pruned. The
 * difference is a bill, not a model.
 */
export interface LatencyPremiumSection {
  policyId: string;
  clusterId: string;
  boundMs: number;
  qualityFloor: number;
  requests: number;
  actualSpendUsd: number;
  /** Null when the bound pruned nothing — there is no cheaper alternative
   * whose absence could be charged for. */
  unboundedStrategy: string | null;
  unboundedSpendUsd: number | null;
  /** actualSpendUsd − unboundedSpendUsd. The month's bill for the bound. */
  premiumUsd: number;
  /** Relax the bound to this p95 and the savings become available at the
   * SAME quality floor — the batch-tolerant customer's action item. */
  relaxLatencyToMs: number | null;
  projectedSavingsPct: number;
  /** The other direction: the quality floor reachable inside the current
   * bound. Surfaced both ways per the owner's refinement. */
  relaxQualityToFloor: number | null;
  /** Whether the frontier latency behind this was measured on served
   * traffic or is still the harness benchmark. */
  latencySource: 'serving' | 'harness';
}

export interface GuaranteeReport {
  orgId: string;
  from: string;
  to: string;
  entries: GuaranteeReportEntry[];
  /** G2.6: one section per compound policy that served traffic in the
   * period. Empty when the org runs no compound policies — the retention
   * thesis stays the report's headline. */
  latencyPremiums: LatencyPremiumSection[];
  /** True when the org has no incumbent designations at all — the whole
   * report is on the labeled legacy path. */
  legacyPath: boolean;
  generatedAt: string;
}

function legOf(row: IncidentRow): 'serve' | 'suite' | 'legacy' {
  const leg = (row.detail as Record<string, unknown>).leg;
  return leg === 'serve' || leg === 'suite' ? leg : 'legacy';
}

function tupleMatches(row: IncidentRow, policyId: string, clusterId: string): boolean {
  const d = row.detail as Record<string, unknown>;
  return d.policyId === policyId && d.clusterId === clusterId;
}

/** Extract the latest retention verdict for a tuple from its incident rows
 * (newest first): a suite-leg breach incident, or a resolved advisory whose
 * resolution carries retention (all-clear / escalation both qualify). */
/** Map a durable verdict row (0029) onto the report headline. Only the two
 * verdict-bearing outcomes render one; recorded refusals (no-suite,
 * budget-refused, …) surface through the verification state instead. */
export function headlineFromVerdict(row: GuaranteeVerdictRow | null): RetentionHeadline | null {
  if (row === null) return null;
  if (row.outcome !== 'contractual-breach' && row.outcome !== 'all-clear') return null;
  const r = row.retention as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object') return null;
  return {
    verdict: row.outcome,
    mean: r.mean as number,
    ci95: r.ci95 as [number, number],
    floor: r.floor as number,
    pairs: r.pairs as number,
    excludedPairs: r.excludedPairs as number,
    seed: r.seed as number,
    confidence: confidenceFor(r.pairs as number),
    providerMode: row.providerMode,
    at: row.createdAt.toISOString(),
    incidentId: row.verdictIncidentId ?? row.id,
  };
}

export function latestRetentionHeadline(
  rows: IncidentRow[],
  policyId: string,
  clusterId: string,
): RetentionHeadline | null {
  const candidates: Array<{ at: Date; headline: RetentionHeadline }> = [];
  for (const row of rows) {
    if (!tupleMatches(row, policyId, clusterId)) continue;
    const d = row.detail as Record<string, unknown>;
    if ((row.kind === 'quality_breach' || row.kind === 'rollback') && d.leg === 'suite' && d.retention) {
      const r = d.retention as Record<string, unknown>;
      candidates.push({
        at: row.createdAt,
        headline: {
          verdict: 'contractual-breach',
          mean: r.mean as number,
          ci95: r.ci95 as [number, number],
          floor: r.floor as number,
          pairs: r.pairs as number,
          excludedPairs: r.excludedPairs as number,
          seed: r.seed as number,
          confidence: confidenceFor(r.pairs as number),
          providerMode: (d.providerMode as string) ?? 'unknown',
          at: row.createdAt.toISOString(),
          incidentId: row.id,
        },
      });
    } else if (row.kind === 'advisory' && row.resolvedAt !== null) {
      const resolution = d.resolution as Record<string, unknown> | undefined;
      const r = resolution?.retention as Record<string, unknown> | undefined;
      if (resolution?.verdict === 'all-clear' && r) {
        candidates.push({
          at: row.resolvedAt,
          headline: {
            verdict: 'all-clear',
            mean: r.mean as number,
            ci95: r.ci95 as [number, number],
            floor: r.floor as number,
            pairs: r.pairs as number,
            excludedPairs: r.excludedPairs as number,
            seed: r.seed as number,
            confidence: confidenceFor(r.pairs as number),
            providerMode: (resolution.providerMode as string) ?? 'unknown',
            at: row.resolvedAt.toISOString(),
            incidentId: row.id,
          },
        });
      }
    }
  }
  candidates.sort((a, b) => b.at.getTime() - a.at.getTime());
  return candidates[0]?.headline ?? null;
}

function incumbentDtoOf(row: ClusterIncumbentRow): IncumbentDto {
  return {
    clusterId: row.clusterId,
    strategyHash: row.strategyHash,
    designatedAt: row.designatedAt.toISOString(),
    status: row.status,
    statusReason: row.statusReason,
  };
}

/** Default read window: last 30 UTC days (savings-report parity). */
function defaultRange(): { fromDay: string; toDay: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  return { fromDay: from.toISOString().slice(0, 10), toDay: to.toISOString().slice(0, 10) };
}

export async function loadGuaranteeReport(
  ctx: PotionContext,
  orgId: string,
  range: { fromDay: string; toDay: string },
): Promise<GuaranteeReport> {
  const now = new Date();
  const windowMinutes = Math.max(
    1,
    Math.ceil((now.getTime() - new Date(`${range.fromDay}T00:00:00Z`).getTime()) / 60_000),
  );
  const [policies, incidents, tuples] = await Promise.all([
    listPoliciesWithGuarantee(ctx.db.db, orgId),
    listIncidents(ctx.db.db, orgId, 1000),
    distinctSampledTargets(ctx.db.db, orgId, windowMinutes, now),
  ]);
  const policyById = new Map(policies.map((p) => [p.id, p.config] as const));
  // One entry per (policy, cluster) with evidence in the window, restricted
  // to guarantee-carrying policies.
  const seen = new Set<string>();
  const pairs: Array<{ policyId: string; clusterId: string }> = [];
  for (const t of tuples) {
    const key = `${t.policyId}|${t.clusterId}`;
    if (seen.has(key) || !policyById.has(t.policyId)) continue;
    seen.add(key);
    pairs.push({ policyId: t.policyId, clusterId: t.clusterId });
  }
  pairs.sort((a, b) => a.policyId.localeCompare(b.policyId) || a.clusterId.localeCompare(b.clusterId));

  let anyIncumbent = false;
  const entries: GuaranteeReportEntry[] = [];
  for (const { policyId, clusterId } of pairs) {
    const config = policyById.get(policyId)!;
    const guarantee = (config as Policy).guarantee!;
    const incumbent = await activeIncumbent(ctx.db.db, orgId, clusterId);
    if (incumbent) anyIncumbent = true;
    let derivedFloor: GuaranteeReportEntry['derivedFloor'] = null;
    let retentionUnavailableReason: string | null = null;
    if (incumbent) {
      const floorRes = await deriveServeFloor(
        ctx.db.db,
        {
          orgId,
          policyId,
          clusterId,
          incumbentHash: incumbent.strategyHash,
          windowMin: guarantee.windowMin,
          minSamples: guarantee.minSamples ?? GUARANTEE_MIN_SAMPLES,
        },
        now,
      );
      if (floorRes.floor !== null && floorRes.provenance !== null) {
        derivedFloor = { floor: floorRes.floor, provenance: floorRes.provenance };
      }
    } else {
      retentionUnavailableReason =
        'retention unavailable — designate an incumbent strategy for this cluster ' +
        '(the org is on the labeled legacy absolute-floor path until then)';
    }
    const tupleIncidents = incidents.filter((i) => tupleMatches(i, policyId, clusterId));
    // 0029: the durable verdict table is the AUTHORITATIVE headline source —
    // it records every outcome, all-clears included, where the incident scan
    // only ever saw breaches and advisory-resolved passes (the gap that left
    // G2.8's all-clear unrecorded). The incident path stays as the fallback
    // for pre-0029 history.
    const verdictRow = await latestVerdictForTuple(ctx.db.db, {
      orgId,
      policyId,
      clusterId,
    });
    // Post-capstone item 3 (Decision 2, owner requirement): the retention
    // HEADLINE is certification-gated at THIS single seam — it covers both
    // the verdict path and the legacy incident scan. An uncertified agentic
    // cluster renders null + reason, never a number: the capstone's 0.2707
    // rendered with only a `low` badge, and that number came from an
    // instrument certification would have refused to vouch for.
    const certState = await certificationStateForCluster(ctx.db.db, clusterId, orgId);
    // The legacy incident scan is PRE-0029 HISTORY ONLY. It cannot see
    // supersession, so once any durable verdict exists for the tuple the scan
    // would republish retracted numbers: every recorded refusal outcome
    // (mode-mismatch, no-suite, budget-refused, insufficient-pairs) makes
    // headlineFromVerdict return null, and the fallback then resurrected the
    // superseded breach's incident as the headline. A retracted verdict is
    // retracted. Found by the invariant sweep.
    const hasDurableVerdict = await tupleHasAnyVerdict(ctx.db.db, { orgId, policyId, clusterId });
    let retention =
      headlineFromVerdict(verdictRow) ??
      (hasDurableVerdict ? null : latestRetentionHeadline(incidents, policyId, clusterId));
    let certGated = false;
    // A headline may only be published when the certification vouches for the
    // INSTRUMENT THAT MEASURED IT. certificationStateForCluster answers about
    // the cluster's CURRENT suite; a verdict measured on an older generation
    // (or while uncertified, its contractual effects withheld) must not be
    // published just because a DIFFERENT suite version later certified.
    const verdictInstrumentCertified =
      certState.certified &&
      (verdictRow === null ||
        verdictRow.suiteId === null ||
        (certState.certification !== undefined &&
          certState.certification.suiteId === verdictRow.suiteId &&
          certState.certification.suiteVersion === verdictRow.suiteVersion));
    if (!verdictInstrumentCertified && retention !== null) {
      retention = null;
      retentionUnavailableReason = !certState.certified
        ? (certState.reason ?? 'suite not certified')
        : `suite not certified for this verdict's instrument — the number was measured on ` +
          `${verdictRow?.suiteId ?? 'an earlier suite'}@${verdictRow?.suiteVersion ?? '?'}, ` +
          `certification vouches for ${certState.certification?.suiteId}@${certState.certification?.suiteVersion} ` +
          '(re-verify on the certified suite)';
      certGated = true;
    }
    const certEvidence = certState.certification?.evidence as
      | { selfRetentionMean?: number }
      | null
      | undefined;
    const certification = clusterId.startsWith('agent-')
      ? {
          certified: certState.certified,
          selfRetentionMean:
            typeof certEvidence?.selfRetentionMean === 'number' ? certEvidence.selfRetentionMean : null,
          reason: certState.reason ?? null,
        }
      : null;
    // ---- G2.2 verification state ----
    const slaMin = guarantee.verifySlaMin ?? GUARANTEE_VERIFY_SLA_MIN;
    const openAdv = tupleIncidents.filter((i) => i.kind === 'advisory' && i.resolvedAt === null);
    const oldest = openAdv.reduce<IncidentRow | null>(
      (acc, i) => (acc === null || i.createdAt < acc.createdAt ? i : acc),
      null,
    );
    const oldestDetail = (oldest?.detail ?? {}) as Record<string, unknown>;
    const ageMin = oldest ? (now.getTime() - oldest.createdAt.getTime()) / 60_000 : null;
    const escalation = oldestDetail.escalation as { at?: string } | undefined;
    const attempts = Array.isArray(oldestDetail.verifyAttempts)
      ? (oldestDetail.verifyAttempts as Array<{ at: string; outcome: string; detail: string | null }>)
      : [];
    const lastAttempt = attempts[attempts.length - 1] ?? null;
    // Unverifiable is computed at report time as well as read from the
    // sweep's escalation stamp — the report never lags the sweep.
    const unverifiable = oldest !== null && (escalation !== undefined || (ageMin ?? 0) > slaMin);
    const verification: VerificationState = {
      state: unverifiable
        ? 'unverifiable'
        : oldest !== null
          ? 'pending'
          : retention !== null
            ? 'verified'
            : 'none',
      openAdvisoryAgeMin: ageMin !== null ? Math.round(ageMin) : null,
      verifyAttempts: attempts.length,
      lastAttempt,
      escalatedAt: escalation?.at ?? null,
      verifySlaMin: slaMin,
    };
    // The certification gate's reason is the most specific and is never
    // overwritten; the pre-existing precedence (unverifiable overwrites the
    // designate-an-incumbent reason) is otherwise unchanged.
    if (!certGated && unverifiable && retention === null) {
      retentionUnavailableReason =
        'guarantee currently unverifiable — suite verification has not produced a verdict ' +
        `within the SLA bound (${slaMin}min)` +
        (lastAttempt ? ` (last attempt: ${lastAttempt.outcome}${lastAttempt.detail ? ` — ${lastAttempt.detail}` : ''})` : ' (no verify attempt recorded yet)');
    } else if (!certGated && retentionUnavailableReason === null && incumbent && retention === null) {
      retentionUnavailableReason = 'no suite-verify verdict yet — retention pending the first verify run';
    }
    entries.push({
      policyId,
      clusterId,
      retention,
      retentionUnavailableReason,
      certification,
      verification,
      incumbent: incumbent ? incumbentDtoOf(incumbent) : null,
      derivedFloor,
      openAdvisories: tupleIncidents
        .filter((i) => i.kind === 'advisory' && i.resolvedAt === null)
        .map(incidentDto),
      incidents: tupleIncidents.map((i) => ({ ...incidentDto(i), leg: legOf(i) })),
      qualitySeries: await qualitySeriesDaily(
        ctx.db.db,
        { orgId, policyId, clusterId },
        { fromDay: range.fromDay, toDay: range.toDay },
      ),
    });
  }
  return {
    orgId,
    from: range.fromDay,
    to: range.toDay,
    entries,
    latencyPremiums: await loadLatencyPremiums(ctx, orgId, range, now),
    legacyPath: !anyIncumbent,
    generatedAt: now.toISOString(),
  };
}

/**
 * The month's REALIZED latency premium per compound policy (G2.6).
 *
 * Same computation as the per-request DTO — latencyPremium() over the same
 * serving-grade-resolved points — priced against the period's ACTUAL served
 * volume instead of a single request. One code path, two time horizons; a
 * second implementation here is exactly how the two surfaces would drift.
 */
async function loadLatencyPremiums(
  ctx: PotionContext,
  orgId: string,
  range: { fromDay: string; toDay: string },
  now: Date,
): Promise<LatencyPremiumSection[]> {
  // ALL the org's policies, not just guarantee-carrying ones: a latency bound
  // is a cost question, and a compound policy is a perfectly ordinary
  // configuration without a quality guarantee attached. Scoping this to
  // listPoliciesWithGuarantee would silently omit the premium for exactly the
  // customers most likely to have set a bound and never looked at it again.
  const all = await listPolicies(ctx.db.db, orgId);
  const compound = all
    .map((p) => ({ id: p.id, config: p.config as Policy }))
    .filter((p) => p.config.type === 'compound');
  if (compound.length === 0) return [];
  const served = await servedSpendByPolicyCluster(ctx.db.db, orgId, range.fromDay, range.toDay);
  const out: LatencyPremiumSection[] = [];
  for (const p of compound) {
    const policy = p.config;
    if (policy.type !== 'compound') continue;
    const clusters = [...new Set(served.filter((s) => s.policyId === p.id).map((s) => s.clusterId))];
    for (const clusterId of clusters.sort()) {
      const rows = served.filter((s) => s.policyId === p.id && s.clusterId === clusterId);
      const requests = rows.reduce((a, r) => a + r.requests, 0);
      const actualSpendUsd = rows.reduce((a, r) => a + r.costUsd, 0);
      const frontier = await loadCurrentFrontier(ctx.db.db, clusterId, orgId);
      if (!frontier || frontier.points.length === 0 || requests === 0) continue;
      const binding = await bindServingLatency(ctx, policy, frontier, orgId, clusterId, () => {}, now);
      const premium = binding.premium;
      // costPer1K is per 1000 REQUESTS, so the counterfactual for `requests`
      // requests is (requests / 1000) × costPer1K.
      const unboundedSpendUsd =
        premium.unbounded === null ? null : (requests / 1000) * premium.unbounded.costPer1K;
      out.push({
        policyId: p.id,
        clusterId,
        boundMs: policy.p95Ms,
        qualityFloor: policy.qualityFloor,
        requests,
        actualSpendUsd,
        unboundedStrategy: premium.binding === 'latency' ? (premium.unbounded?.strategyHash ?? null) : null,
        unboundedSpendUsd: premium.binding === 'latency' ? unboundedSpendUsd : null,
        premiumUsd:
          premium.binding === 'latency' && unboundedSpendUsd !== null
            ? Math.max(0, actualSpendUsd - unboundedSpendUsd)
            : 0,
        relaxLatencyToMs: premium.relaxLatencyToMs,
        projectedSavingsPct: premium.savingsPct,
        relaxQualityToFloor: premium.relaxQualityToFloor,
        latencySource: binding.source,
      });
    }
  }
  return out;
}

export function registerGuaranteeReportRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.get('/api/reports/guarantee', async (req, reply) => {
    // The /api auth hook resolves bearer api keys AND session cookies into
    // req.potionOrg (the savings route's resolveRequestOrg is bearer-only —
    // a session-cookie caller would silently fall back to the demo org).
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const q = (req.query ?? {}) as Record<string, unknown>;
    let range: { fromDay: string; toDay: string };
    if (typeof q.period === 'string') {
      if (!isPeriodString(q.period)) {
        return reply.code(400).send(openAiError('period must be YYYY-MM', 'invalid_request_error'));
      }
      range = { fromDay: periodFromDay(q.period), toDay: periodToDay(q.period) };
    } else {
      const dflt = defaultRange();
      range = {
        fromDay: typeof q.from === 'string' ? q.from : dflt.fromDay,
        toDay: typeof q.to === 'string' ? q.to : dflt.toDay,
      };
      if (!isDayString(range.fromDay) || !isDayString(range.toDay)) {
        return reply.code(400).send(openAiError('from/to must be YYYY-MM-DD', 'invalid_request_error'));
      }
    }
    const report = await loadGuaranteeReport(ctx, org.orgId, range);
    if (q.format === 'html') {
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(renderGuaranteeReportHtml(report));
    }
    return reply.send(report);
  });
}

export { PLATFORM_RETENTION_FLOOR };

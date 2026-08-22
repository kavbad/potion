// Savings report routes (M3, ROADMAP #21, SPEC §12.4).
//
//   GET /api/reports/savings?from&to      SavingsReport JSON (org-scoped)
//   GET /api/reports/savings.csv?from&to  the same alternatives as CSV
//
// The report answers: "what would the shadowed candidate strategies have
// cost over this window, vs what we actually spent?" actualSpendUsd comes
// from the LIVE request_logs usage rollup (same math as /api/usage/current
// — the batch usage_daily table is not required). Each candidate strategy
// with ≥1 shadow sample in the window projects:
//   projectedSpendUsd = mean(shadow cost_usd) × requestCount
//   projectedQuality  = mean(shadow quality) over scored samples
//   deltaUsd          = actualSpendUsd − projectedSpendUsd
//   confidence        = low <30 samples, medium <200, high ≥200
//
// PROJECTION SCOPE (documented choice): "request count" is the org's TOTAL
// served request count in the window (status='ok'), and actualSpendUsd is
// the org's total served spend — both at the same scope, so deltaUsd is
// apples-to-apples. Cluster-scoped projection (candidate mean × requests
// in the clusters it was sampled in) is a follow-up refinement.
import type { FastifyInstance } from 'fastify';
import type { StrategyConfig } from '@potion/core';
import {
  certificationStateForCluster,
  getStrategyConfigs,
  isDayString,
  listShadowResults,
  liveUsageRollup,
  sumRollup,
  type ShadowResultRow,
} from '@potion/db';
import { openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';

// ---- report contract (SPEC §12.4) ----

export type Confidence = 'low' | 'medium' | 'high';

export interface SavingsAlternative {
  strategyHash: string;
  label: string;
  projectedSpendUsd: number;
  projectedQuality: number;
  deltaUsd: number;
  sampleSize: number;
  confidence: Confidence;
}

export interface SavingsReport {
  orgId: string;
  from: string;
  to: string;
  actualSpendUsd: number;
  alternatives: SavingsAlternative[];
  /**
   * Post-capstone item 3 (Decision 2, owner requirement): shadow samples
   * from UNCERTIFIED agentic clusters are WITHHELD from the projection —
   * without this seam the org-total headline silently launders uncertified
   * claims into a dollar figure. Withheld contributions are reported, never
   * hidden. NOTE (recorded scope): the denominator (actualSpendUsd /
   * requestCount) stays org-total per the SPEC §12.4 documented choice;
   * cluster-scoping it is the named follow-up.
   */
  withheld: Array<{ clusterId: string; samples: number; reason: string }>;
}

/** Confidence tier by sample size (SPEC §12.4): low <30, medium <200, high ≥200. */
export function confidenceFor(sampleSize: number): Confidence {
  if (sampleSize < 30) return 'low';
  if (sampleSize < 200) return 'medium';
  return 'high';
}

/** Default read window: the last 30 UTC days (inclusive of today) — same
 * default as /api/usage. */
function defaultRange(): { fromDay: string; toDay: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  return { fromDay: from.toISOString().slice(0, 10), toDay: to.toISOString().slice(0, 10) };
}

/** Short human label for a strategy config (report tables; the dashboard
 * has the long-form describeStrategy for frontier points). */
export function describeStrategyBrief(config: StrategyConfig): string {
  switch (config.type) {
    case 'single':
      return `single · ${config.model}`;
    case 'cascade':
      return `cascade · ${config.stages.map((s) => s.model).join('→')}`;
    case 'best-of-n':
      return `best-of-${config.n} · ${config.model}`;
    case 'draft-verify':
      return `draft-verify · ${config.draftModel}→${config.verifierModel}`;
    case 'ensemble':
      return `ensemble · ${config.models.join('+')}`;
    case 'decompose':
      return `decompose · ${config.decomposerModel}`;
    case 'composite':
      return `composite · ${config.startModel}→${config.upgradeModel}`;
    case 'program':
      return `program · ${config.name}`;
  }
}

/**
 * Pure report builder (unit-tested to the cent): group the window's shadow
 * rows by candidate hash and project each against the window totals.
 * `configs` labels known hashes; unknown ones fall back to the recorded
 * candidate_model + short hash.
 */
export function buildSavingsReport(
  scope: { orgId: string; fromDay: string; toDay: string },
  totals: { actualSpendUsd: number; requestCount: number },
  rows: ShadowResultRow[],
  configs: Map<string, StrategyConfig>,
  /** clusterId → reason for clusters whose samples must be withheld
   * (uncertified agentic suites). Empty map = nothing withheld. */
  withheldClusters: Map<string, string> = new Map(),
): SavingsReport {
  const withheldCount = new Map<string, number>();
  const usable = rows.filter((r) => {
    if (!withheldClusters.has(r.clusterId)) return true;
    withheldCount.set(r.clusterId, (withheldCount.get(r.clusterId) ?? 0) + 1);
    return false;
  });
  const byCandidate = new Map<string, ShadowResultRow[]>();
  for (const r of usable) {
    const group = byCandidate.get(r.candidateHash);
    if (group) group.push(r);
    else byCandidate.set(r.candidateHash, [r]);
  }
  const alternatives: SavingsAlternative[] = [...byCandidate.entries()]
    .map(([hash, samples]) => {
      const meanCost = samples.reduce((s, r) => s + r.costUsd, 0) / samples.length;
      const scored = samples.filter((r) => r.quality !== null);
      const meanQuality =
        scored.length === 0
          ? 0
          : scored.reduce((s, r) => s + (r.quality ?? 0), 0) / scored.length;
      const projectedSpendUsd = meanCost * totals.requestCount;
      const config = configs.get(hash);
      return {
        strategyHash: hash,
        label: config
          ? describeStrategyBrief(config)
          : `${samples[0]!.candidateModel} (${hash.slice(0, 8)})`,
        projectedSpendUsd,
        projectedQuality: meanQuality,
        deltaUsd: totals.actualSpendUsd - projectedSpendUsd,
        sampleSize: samples.length,
        confidence: confidenceFor(samples.length),
      };
    })
    .sort((a, b) => b.deltaUsd - a.deltaUsd || a.strategyHash.localeCompare(b.strategyHash));
  return {
    orgId: scope.orgId,
    from: scope.fromDay,
    to: scope.toDay,
    actualSpendUsd: totals.actualSpendUsd,
    alternatives,
    withheld: [...withheldCount.entries()]
      .map(([clusterId, samples]) => ({
        clusterId,
        samples,
        reason: withheldClusters.get(clusterId) ?? 'suite not certified',
      }))
      .sort((a, b) => a.clusterId.localeCompare(b.clusterId)),
  };
}

// ---- CSV export ----

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** 6-decimal rounding keeps cent precision without float noise in exports. */
function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

export function savingsCsv(report: SavingsReport): string {
  const header =
    'strategy_hash,label,sample_size,confidence,projected_spend_usd,projected_quality,delta_usd,actual_spend_usd';
  const lines = report.alternatives.map((a) =>
    [
      a.strategyHash,
      a.label,
      a.sampleSize,
      a.confidence,
      fmt(a.projectedSpendUsd),
      fmt(a.projectedQuality),
      fmt(a.deltaUsd),
      fmt(report.actualSpendUsd),
    ]
      .map(csvCell)
      .join(','),
  );
  // Withheld contributions are part of the export — an analyst diffing the
  // CSV against raw shadow rows must see WHY samples are missing.
  const withheldLines = report.withheld.map((w) =>
    ['# withheld', w.clusterId, w.samples, '', '', '', '', csvCell(w.reason)].join(','),
  );
  return [header, ...lines, ...withheldLines].join('\n') + '\n';
}

// ---- routes ----

// Exported for the M4 #31 public share endpoint (routes/share.ts): a shared
// 'report' link renders the SAME report the authed /api/reports/savings route
// serves, scoped to the token's org.
export async function loadReport(
  ctx: PotionContext,
  orgId: string,
  range: { fromDay: string; toDay: string },
): Promise<SavingsReport> {
  const rollup = sumRollup(await liveUsageRollup(ctx.db.db, orgId, range));
  const rows = await listShadowResults(ctx.db.db, orgId, range);
  const configs = new Map(
    (await getStrategyConfigs(ctx.db.db, [...new Set(rows.map((r) => r.candidateHash))])).map(
      (r) => [r.hash, r.config] as const,
    ),
  );
  // Post-capstone item 3: samples from uncertified agentic clusters are
  // withheld (certification governs derived agentic suites; non-agent
  // clusters pass through). One predicate call per distinct agent cluster.
  const withheldClusters = new Map<string, string>();
  for (const clusterId of new Set(rows.map((r) => r.clusterId))) {
    if (!clusterId.startsWith('agent-')) continue;
    const state = await certificationStateForCluster(ctx.db.db, clusterId, orgId);
    if (!state.certified) {
      withheldClusters.set(clusterId, state.reason ?? 'suite not certified');
    }
  }
  return buildSavingsReport(
    { orgId, fromDay: range.fromDay, toDay: range.toDay },
    { actualSpendUsd: rollup.costUsd, requestCount: rollup.requests },
    rows,
    configs,
    withheldClusters,
  );
}

function parseWindow(query: unknown): { fromDay: string; toDay: string } {
  const dflt = defaultRange();
  const q = (query ?? {}) as Record<string, unknown>;
  return {
    fromDay: typeof q.from === 'string' ? q.from : dflt.fromDay,
    toDay: typeof q.to === 'string' ? q.to : dflt.toDay,
  };
}

export function registerReportRoutes(app: FastifyInstance, ctx: PotionContext): void {
  // ---- GET /api/reports/savings — org-scoped SavingsReport ----
  app.get('/api/reports/savings', async (req, reply) => {
    // G2.4: the /api hook already resolved bearer OR cookie OR dev bypass.
    // The old bearer-only helper silently served the demo org to every
    // dashboard (cookie) caller.
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const range = parseWindow(req.query);
    if (!isDayString(range.fromDay) || !isDayString(range.toDay)) {
      return reply.code(400).send(openAiError('from/to must be YYYY-MM-DD', 'invalid_request_error'));
    }
    return reply.send(await loadReport(ctx, org.orgId, range));
  });

  // ---- GET /api/reports/savings.csv — same alternatives, CSV download ----
  app.get('/api/reports/savings.csv', async (req, reply) => {
    // G2.4: the /api hook already resolved bearer OR cookie OR dev bypass.
    // The old bearer-only helper silently served the demo org to every
    // dashboard (cookie) caller.
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const range = parseWindow(req.query);
    if (!isDayString(range.fromDay) || !isDayString(range.toDay)) {
      return reply.code(400).send(openAiError('from/to must be YYYY-MM-DD', 'invalid_request_error'));
    }
    const report = await loadReport(ctx, org.orgId, range);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="potion-savings_${org.orgId}_${range.fromDay}_${range.toDay}.csv"`,
      )
      .send(savingsCsv(report));
  });
}

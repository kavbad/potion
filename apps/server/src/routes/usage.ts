// Usage + invoice routes (M2 Wave 2, ROADMAP #17/#18) — the metered-usage
// read surface behind the dashboard /usage page and the CSV/invoice exports.
//
//   GET  /api/usage?from&to&group_by=day|cluster   usage_daily rows (batch)
//   GET  /api/usage/current                        today + MTD, LIVE from request_logs
//   GET  /api/usage/export.csv?from&to             CSV download (day × cluster)
//   POST /api/usage/aggregate {from,to}            trigger the batch rollup
//   GET  /api/usage/invoice?period&margin_pct&format=json|html
//
// Auth / tenant scope: a valid Bearer api key pins the org (Wave-1 semantics
// — org keys carry full org power). With no Authorization header the local-
// tool default org (org_demo) is used, matching the other /api dashboard
// routes. SESSION-TOLERANT RESOLVER: when the Wave-2 auth agent lands
// dashboard sessions (#14), extend resolveRequestOrg() to try the session
// cookie FIRST via resolveOrgContext(db, { kind: 'session', userId, orgId })
// and fall back to the bearer path — handlers below only see OrgContext and
// need no further changes. Every query is org-scoped; cross-org reads are
// impossible by construction.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_ORG_ID,
  aggregateUsage,
  assertDayRange,
  isDayString,
  isPeriodString,
  listUsageDaily,
  liveUsageRollup,
  periodFromDay,
  periodToDay,
  resolveOrgContext,
  sumRollup,
  utcDay,
  type OrgContext,
  type UsageDailyRow,
} from '@potion/db';
import { bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import { generateInvoice } from '../billing/invoice.js';
import { renderInvoiceHtml } from '../billing/render-html.js';

const UsageQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  group_by: z.enum(['day', 'cluster']).default('day'),
});

const AggregateBodySchema = z.object({
  from: z.string(),
  to: z.string(),
});

const InvoiceQuerySchema = z.object({
  period: z.string(),
  margin_pct: z.coerce.number().min(0).optional(),
  format: z.enum(['json', 'html']).default('json'),
});

/** Default read window: the last 30 UTC days (inclusive of today). */
function defaultRange(): { fromDay: string; toDay: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  return { fromDay: from.toISOString().slice(0, 10), toDay: to.toISOString().slice(0, 10) };
}

/**
 * Session-tolerant org resolver (see file header). Bearer key → its org; no
 * credentials → the local-tool default org; a PRESENT but invalid bearer
 * token → null (the route answers 401, never silently widening scope).
 */
export async function resolveRequestOrg(
  ctx: PotionContext,
  req: FastifyRequest,
): Promise<OrgContext | null> {
  const token = bearerToken(req.headers.authorization);
  if (token) {
    return resolveOrgContext(ctx.db.db, { kind: 'apiKey', apiKey: token });
  }
  return { orgId: DEFAULT_ORG_ID, role: 'admin' };
}

interface UsageClusterSlice {
  clusterId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  platformCostUsd: number;
}

function sliceOf(r: UsageDailyRow): UsageClusterSlice {
  return {
    clusterId: r.clusterId,
    requests: r.requests,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    platformCostUsd: r.platformCostUsd,
  };
}

const ZERO = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, platformCostUsd: 0 };

function addSlice(
  acc: typeof ZERO,
  s: UsageClusterSlice,
): typeof ZERO {
  return {
    requests: acc.requests + s.requests,
    inputTokens: acc.inputTokens + s.inputTokens,
    outputTokens: acc.outputTokens + s.outputTokens,
    costUsd: acc.costUsd + s.costUsd,
    platformCostUsd: acc.platformCostUsd + s.platformCostUsd,
  };
}

/** group_by=day: one row per day, each with its per-cluster breakdown. */
export function shapeByDay(rows: UsageDailyRow[]) {
  const days = new Map<string, { day: string } & typeof ZERO & { clusters: UsageClusterSlice[] }>();
  for (const r of rows) {
    let d = days.get(r.day);
    if (!d) {
      d = { day: r.day, ...ZERO, clusters: [] };
      days.set(r.day, d);
    }
    const s = sliceOf(r);
    d.clusters.push(s);
    Object.assign(d, addSlice(d, s));
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** group_by=cluster: one row per cluster over the whole window + avg $/1K. */
export function shapeByCluster(rows: UsageDailyRow[]) {
  const clusters = new Map<string, UsageClusterSlice & { avgCostPer1K: number }>();
  for (const r of rows) {
    const s = sliceOf(r);
    const acc = clusters.get(r.clusterId) ?? { ...s, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, platformCostUsd: 0, avgCostPer1K: 0 };
    const next = addSlice(acc, s);
    clusters.set(r.clusterId, { clusterId: r.clusterId, ...next, avgCostPer1K: 0 });
  }
  return [...clusters.values()]
    .map((c) => ({
      ...c,
      avgCostPer1K: c.requests > 0 ? c.costUsd / (c.requests / 1000) : 0,
    }))
    .sort((a, b) => a.clusterId.localeCompare(b.clusterId));
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function usageCsv(rows: UsageDailyRow[]): string {
  const header = 'day,cluster_id,requests,input_tokens,output_tokens,cost_usd,platform_cost_usd';
  const lines = rows.map((r) =>
    [r.day, r.clusterId, r.requests, r.inputTokens, r.outputTokens, r.costUsd, r.platformCostUsd]
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

export function registerUsageRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = () => ctx.db.db;

  // ---- GET /api/usage — usage_daily, org-scoped ----
  app.get('/api/usage', async (req, reply) => {
    const org = await resolveRequestOrg(ctx, req);
    if (!org) {
      return reply.code(401).send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const q = UsageQuerySchema.safeParse(req.query);
    const dflt = defaultRange();
    const fromDay = q.success ? (q.data.from ?? dflt.fromDay) : dflt.fromDay;
    const toDay = q.success ? (q.data.to ?? dflt.toDay) : dflt.toDay;
    const groupBy = q.success ? q.data.group_by : 'day';
    if (!isDayString(fromDay) || !isDayString(toDay)) {
      return reply.code(400).send(openAiError('from/to must be YYYY-MM-DD', 'invalid_request_error'));
    }
    const rows = await listUsageDaily(db(), org.orgId, { fromDay, toDay });
    return reply.send({
      orgId: org.orgId,
      from: fromDay,
      to: toDay,
      groupBy,
      rows: groupBy === 'day' ? shapeByDay(rows) : shapeByCluster(rows),
    });
  });

  // ---- GET /api/usage/current — LIVE from request_logs (not usage_daily):
  // the in-flight day is not yet rolled up by the batch job, so this endpoint
  // runs the same rollup math read-only. ----
  app.get('/api/usage/current', async (req, reply) => {
    const org = await resolveRequestOrg(ctx, req);
    if (!org) {
      return reply.code(401).send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const today = utcDay();
    const monthStart = `${today.slice(0, 7)}-01`;
    const todayRows = await liveUsageRollup(db(), org.orgId, { fromDay: today, toDay: today });
    const mtdRows = await liveUsageRollup(db(), org.orgId, { fromDay: monthStart, toDay: today });
    return reply.send({
      orgId: org.orgId,
      today: { day: today, ...sumRollup(todayRows) },
      mtd: { from: monthStart, to: today, ...sumRollup(mtdRows) },
    });
  });

  // ---- GET /api/usage/export.csv — day × cluster CSV download ----
  app.get('/api/usage/export.csv', async (req, reply) => {
    const org = await resolveRequestOrg(ctx, req);
    if (!org) {
      return reply.code(401).send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const dflt = defaultRange();
    const q = req.query as Record<string, unknown>;
    const fromDay = typeof q.from === 'string' ? q.from : dflt.fromDay;
    const toDay = typeof q.to === 'string' ? q.to : dflt.toDay;
    if (!isDayString(fromDay) || !isDayString(toDay)) {
      return reply.code(400).send(openAiError('from/to must be YYYY-MM-DD', 'invalid_request_error'));
    }
    const rows = await listUsageDaily(db(), org.orgId, { fromDay, toDay });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="potion-usage_${org.orgId}_${fromDay}_${toDay}.csv"`)
      .send(usageCsv(rows));
  });

  // ---- POST /api/usage/aggregate — the batch rollup trigger (same function
  // the `aggregate` CLI job runs; idempotent). ----
  app.post('/api/usage/aggregate', async (req, reply) => {
    const parsed = AggregateBodySchema.safeParse(req.body);
    if (!parsed.success || !isDayString(parsed.data.from) || !isDayString(parsed.data.to)) {
      return reply.code(400).send(openAiError('body must be {from, to} as YYYY-MM-DD', 'invalid_request_error'));
    }
    const range = { fromDay: parsed.data.from, toDay: parsed.data.to };
    assertDayRange(range);
    const rows = await aggregateUsage(db(), range);
    return reply.send({ from: range.fromDay, to: range.toDay, rowsUpserted: rows.length, rows });
  });

  // ---- GET /api/usage/invoice — generate + return the Stripe-ready invoice
  // JSON (or print-friendly HTML). Refreshes the period rollup first so the
  // invoice is current to the cent (idempotent upsert — see billing/cli). ----
  app.get('/api/usage/invoice', async (req, reply) => {
    const org = await resolveRequestOrg(ctx, req);
    if (!org) {
      return reply.code(401).send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const parsed = InvoiceQuerySchema.safeParse(req.query);
    if (!parsed.success || !isPeriodString(parsed.data.period)) {
      return reply.code(400).send(openAiError('period must be YYYY-MM', 'invalid_request_error'));
    }
    const { period, format } = parsed.data;
    const range = { fromDay: periodFromDay(period), toDay: periodToDay(period) };
    await aggregateUsage(db(), range);
    try {
      const invoice = await generateInvoice(
        db(),
        org.orgId,
        period,
        parsed.data.margin_pct !== undefined ? { marginPct: parsed.data.margin_pct } : {},
      );
      if (format === 'html') {
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-disposition', `inline; filename="${invoice.id}.html"`)
          .send(renderInvoiceHtml(invoice));
      }
      return reply.send(invoice);
    } catch (err) {
      return reply.code(400).send(openAiError((err as Error).message, 'invalid_request_error'));
    }
  });
}

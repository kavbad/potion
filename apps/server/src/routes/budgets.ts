// Budget autopilot routes (M4, ROADMAP #35, SPEC §13.7).
//
//   GET /api/budgets   viewer+ — the org's budget row (or null) + live MTD
//                      spend, linear month-end forecast, warn threshold and
//                      the derived state ('ok' | 'warn' | 'exceeded'). The
//                      dashboard budget card renders from this.
//   PUT /api/budgets   admin  — upsert {monthlyCapUsd, hardStop, warnPct}.
//
// Also home of the SERVING-PATH hard-stop check (checkBudgetHardStop):
// routes/chat.ts consults it before execution. Semantics:
//   * hardStop=false (soft cap, the default) NEVER blocks serving;
//   * hardStop=true fails CLOSED at the cap → 429 budget_exceeded;
//   * the read is cached 60s per org (the serving path must not pay an MTD
//     aggregate per request);
//   * a check ERROR (db hiccup) fails OPEN — availability wins; the nightly
//     budget:evaluate sweep still raises budget_warning/budget_exceeded
//     alerts (documented choice, mirrors the staleness tolerances).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  forecastMtdUsd,
  getBudget,
  mtdSpendUsd,
  upsertBudget,
  warnAtUsd,
  type BudgetRow,
} from '@potion/db';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface BudgetHardStopResult {
  stopped: boolean;
  budget: BudgetRow | null;
  mtdUsd: number;
}

interface CacheEntry {
  at: number;
  result: BudgetHardStopResult;
}

/** 60s per-org cache (SPEC §13.7: "cached 60s per org"). */
const HARD_STOP_TTL_MS = 60_000;
const hardStopCache = new Map<string, CacheEntry>();

/** Test hook: clear the serving-path hard-stop cache. */
export function clearBudgetHardStopCache(): void {
  hardStopCache.clear();
}

/** The serving-path budget check. Cached; soft caps never stop; check
 * errors fail OPEN (documented above). */
export async function checkBudgetHardStop(
  ctx: PotionContext,
  orgId: string,
): Promise<BudgetHardStopResult> {
  const cached = hardStopCache.get(orgId);
  if (cached && Date.now() - cached.at < HARD_STOP_TTL_MS) return cached.result;
  try {
    const budget = await getBudget(ctx.db.db, orgId);
    if (!budget || !budget.hardStop) {
      const result: BudgetHardStopResult = { stopped: false, budget, mtdUsd: 0 };
      hardStopCache.set(orgId, { at: Date.now(), result });
      return result;
    }
    const mtdUsd = await mtdSpendUsd(ctx.db.db, orgId);
    const result: BudgetHardStopResult = {
      stopped: mtdUsd >= budget.monthlyCapUsd,
      budget,
      mtdUsd,
    };
    hardStopCache.set(orgId, { at: Date.now(), result });
    return result;
  } catch {
    // fail open — availability over enforcement (see header)
    return { stopped: false, budget: null, mtdUsd: 0 };
  }
}

const UpsertBudgetSchema = z
  .object({
    monthlyCapUsd: z.number().positive().max(1e9),
    hardStop: z.boolean().optional(),
    warnPct: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export function registerBudgetRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.get('/api/budgets', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const budget = await getBudget(ctx.db.db, org.orgId);
    const mtdUsd = await mtdSpendUsd(ctx.db.db, org.orgId);
    const forecastUsd = forecastMtdUsd(mtdUsd);
    const warnAt = budget ? warnAtUsd(budget.monthlyCapUsd, budget.warnPct) : null;
    const state: 'ok' | 'warn' | 'exceeded' | 'unconfigured' = !budget
      ? 'unconfigured'
      : mtdUsd >= budget.monthlyCapUsd
        ? 'exceeded'
        : mtdUsd >= warnAt!
          ? 'warn'
          : 'ok';
    return reply.send({
      budget: budget
        ? {
            monthlyCapUsd: budget.monthlyCapUsd,
            hardStop: budget.hardStop,
            warnPct: budget.warnPct,
            updatedAt: budget.updatedAt.toISOString(),
          }
        : null,
      mtdUsd,
      forecastUsd,
      warnAtUsd: warnAt,
      state,
    });
  });

  app.put('/api/budgets', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not set the budget — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const parsed = UpsertBudgetSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const existing = await getBudget(ctx.db.db, org.orgId);
    const row = await upsertBudget(ctx.db.db, {
      orgId: org.orgId,
      monthlyCapUsd: parsed.data.monthlyCapUsd,
      hardStop: parsed.data.hardStop ?? existing?.hardStop ?? false,
      warnPct: parsed.data.warnPct ?? existing?.warnPct ?? 80,
    });
    // The serving-path cache must observe the new row IMMEDIATELY (an admin
    // lowering the cap below MTD expects the next request to 429).
    hardStopCache.delete(org.orgId);
    return reply.send({
      budget: {
        monthlyCapUsd: row.monthlyCapUsd,
        hardStop: row.hardStop,
        warnPct: row.warnPct,
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  });
}

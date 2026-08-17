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
//
// SERVING-ROADMAP S4 AMENDS THE ABOVE for traffic PLATFORM keys fund. Those
// three bullets were written when the customer paid; two of them are wrong
// when Potion does. See the S4 block below for the amendments and why they
// are scoped to live + platform-paid only — under mock, and for any BYOK
// org, the semantics above stand unchanged.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  forecastMtdUsd,
  getBudget,
  insertRequestLog,
  mtdSpendUsd,
  platformSpendUsdForDay,
  recordBudgetEvent,
  upsertBudget,
  warnAtUsd,
  type BudgetRow,
  type NewRequestLog,
} from '@potion/db';
import { openAiError, roleAtLeast } from '../auth.js';
import { emitAlert } from '../alerts.js';
import type { PotionContext } from '../context.js';

/**
 * SPENDING SAFETY ON OUR OWN KEY (SERVING-ROADMAP S4).
 *
 * Every rule below was harmless while the CUSTOMER paid and is dangerous now
 * that Potion serves from its own provider keys. That is the whole reason
 * this section exists: the semantics above were not wrong, they were written
 * for a different payer.
 *
 * WHO PAYS is answerable per request today, without waiting for S3's
 * `paid_by` column: an org with no servable BYOK key of its own resolves to
 * the platform provider set (`providersForOrg().byok === false`). That is
 * what makes S4 possible before S3 — the persistence is missing, the FACT is
 * not.
 *
 * Three knobs, and the asymmetry between them is deliberate:
 *
 *   · POTION_PLATFORM_ORG_CAP_USD — DEFAULTS ON. An org with no budget row
 *     had no cap at all, so a freshly self-served org could spend without
 *     limit on our key. There is no safe "unset" for that, so a default
 *     applies to every platform-paid org that has not set its own.
 *   · POTION_PLATFORM_DAILY_CAP_USD — DEFAULTS OFF. A global ceiling is a
 *     blast radius: a wrong value stops ALL serving at once. That is the
 *     operator's number to choose deliberately, not ours to guess.
 *   · Fail CLOSED on a check error, but ONLY when we pay. Failing open is
 *     right when it is the customer's money (availability wins); it is
 *     unbounded spend on our card when it is not.
 *
 * All three are scoped to `providerMode === 'live'`. Under mock providers no
 * real money moves, so none of this changes behaviour for tests, dev, or the
 * walkthrough — the protection appears exactly when the risk does.
 */

/** Default monthly cap for a platform-paid org with no budget row of its own. */
export const DEFAULT_PLATFORM_ORG_CAP_USD = 10;

/** Env knobs, named here so tests and docs cannot drift from the code. */
export const PLATFORM_ORG_CAP_ENV = 'POTION_PLATFORM_ORG_CAP_USD';
export const PLATFORM_DAILY_CAP_ENV = 'POTION_PLATFORM_DAILY_CAP_USD';

function envPositiveNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  // A malformed knob must not silently mean "no limit" — that is the failure
  // mode this whole section exists to prevent. Unparseable ⇒ treated as
  // unset for the DAILY cap (off by default anyway) and, for the org cap,
  // falls back to the built-in default rather than to infinity.
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The per-org cap applied to platform-paid orgs that set none themselves. */
export function platformOrgCapUsd(): number {
  return envPositiveNumber(PLATFORM_ORG_CAP_ENV) ?? DEFAULT_PLATFORM_ORG_CAP_USD;
}

/** The platform-wide daily ceiling; null = not configured (no global stop). */
export function platformDailyCapUsd(): number | null {
  return envPositiveNumber(PLATFORM_DAILY_CAP_ENV);
}

/**
 * Does POTION pay for this org's traffic?
 *
 * Mock mode is always false — nothing is at stake, so none of the S4 rules
 * fire and every existing test keeps its behaviour. Under live, an org with
 * no servable BYOK key rides the platform key set, and that is us.
 *
 * An ERROR resolving this answers TRUE. If we cannot tell who pays, the safe
 * assumption is that we do; guessing "the customer" on a db hiccup is the
 * fail-open this fix exists to remove.
 */
export async function platformPaysFor(ctx: PotionContext, orgId: string): Promise<boolean> {
  if (ctx.providerMode !== 'live') return false;
  try {
    return !(await ctx.providersForOrg(orgId)).byok;
  } catch {
    return true;
  }
}

/**
 * Money for humans, at whatever precision the number actually needs.
 *
 * `toFixed(2)` is right for dollars and silently wrong below a cent: the S4
 * live leg's refusal came back reading "platform daily spending ceiling
 * reached: $0.00 ≥ $0.00", which is both useless and faintly alarming. Small
 * thresholds are exactly the ones a nervous operator sets first, so the
 * refusal has to stay legible there.
 */
export function formatUsd(n: number): string {
  if (n === 0) return '0.00';
  if (Math.abs(n) >= 0.01) return n.toFixed(2);
  // Below a cent, SIGNIFICANT FIGURES rather than fixed decimals. A fixed
  // 4dp would render the live leg's $0.000214 as "0.0002" — equal to the
  // $0.0002 cap it had just exceeded, hiding the overshoot the message
  // exists to report.
  return n.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Why serving was stopped — carried to the log, the alert and the tests. */
export type BudgetStopReason =
  | 'org-cap'
  | 'platform-org-default-cap'
  | 'platform-daily-cap'
  | 'check-failed-platform-paid';

export interface BudgetHardStopResult {
  stopped: boolean;
  budget: BudgetRow | null;
  mtdUsd: number;
  /** Set exactly when stopped. */
  reason?: BudgetStopReason;
  /** The cap that was hit (monthly for org caps, daily for the platform one). */
  capUsd?: number;
  /** True when Potion's own key was funding this org's traffic. */
  platformPaid?: boolean;
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

  // Resolved before the try: `platformPaysFor` swallows its own errors and
  // answers TRUE when it cannot tell, so the catch below always knows which
  // side to fail to.
  const platformPaid = await platformPaysFor(ctx, orgId);

  try {
    const budget = await getBudget(ctx.db.db, orgId);

    // The platform-wide ceiling, checked FIRST and only when we are paying:
    // it is the operator's stop-everything switch, so no per-org
    // configuration may sit above it.
    const dailyCap = platformPaid ? platformDailyCapUsd() : null;
    if (dailyCap !== null) {
      const spentToday = await platformSpendUsdForDay(ctx.db.db);
      if (spentToday >= dailyCap) {
        const result: BudgetHardStopResult = {
          stopped: true,
          budget,
          mtdUsd: spentToday,
          reason: 'platform-daily-cap',
          capUsd: dailyCap,
          platformPaid,
        };
        hardStopCache.set(orgId, { at: Date.now(), result });
        return result;
      }
    }

    // A platform-paid org with NO hard cap of its own is the unbounded case:
    // before S4 it served without limit on our key. The default cap applies
    // to exactly that org, and never overrides one the customer set.
    const effectiveCap =
      budget?.hardStop === true
        ? { cap: budget.monthlyCapUsd, reason: 'org-cap' as const }
        : platformPaid
          ? { cap: platformOrgCapUsd(), reason: 'platform-org-default-cap' as const }
          : null;

    if (effectiveCap === null) {
      const result: BudgetHardStopResult = { stopped: false, budget, mtdUsd: 0, platformPaid };
      hardStopCache.set(orgId, { at: Date.now(), result });
      return result;
    }

    const mtdUsd = await mtdSpendUsd(ctx.db.db, orgId);
    const stopped = mtdUsd >= effectiveCap.cap;
    const result: BudgetHardStopResult = {
      stopped,
      budget,
      mtdUsd,
      ...(stopped ? { reason: effectiveCap.reason, capUsd: effectiveCap.cap } : {}),
      platformPaid,
    };
    hardStopCache.set(orgId, { at: Date.now(), result });
    return result;
  } catch {
    // The asymmetry, and the point of S4. Failing OPEN is right when the
    // CUSTOMER pays: their money, and availability wins over enforcement.
    // When WE pay it is unbounded spend on our own card for as long as the
    // db is unhappy, which is precisely when nobody is watching.
    //
    // NOT cached either way: a transient failure must not pin an answer for
    // 60 seconds — the next request re-checks.
    if (platformPaid) {
      return {
        stopped: true,
        budget: null,
        mtdUsd: 0,
        reason: 'check-failed-platform-paid',
        platformPaid,
      };
    }
    return { stopped: false, budget: null, mtdUsd: 0, platformPaid };
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

/**
 * THE serving-path hard-stop guard — the ONE seam every spend-bearing route
 * goes through (F6).
 *
 * This block used to live inline in /v1/chat/completions only, so
 * /v1/completions and /v1/embeddings served past an exceeded hard cap: the
 * same credential simply switched endpoints. That is the "handled in one
 * route is not handled" class G2.4 closed for tenancy and G2.6 closed for
 * latency bounds (see latency-policy.ts) — here it had a customer's money
 * behind it.
 *
 * Performs the whole refusal when it refuses: the budget_exceeded
 * request_logs row, the per-(org, kind, UTC day) deduped alert through the
 * budget_events ledger, and the 429. Returns true iff it replied, so callers
 * `if (await enforceBudgetHardStop(...)) return;`.
 *
 * Soft caps NEVER block, and the underlying check is cached 60s/org and
 * fails OPEN on db errors — both deliberate (see this file's header). This
 * guard widens WHO asks the gate; it does not change what the gate decides.
 */
export async function enforceBudgetHardStop(
  ctx: PotionContext,
  orgId: string,
  reply: { code(n: number): { send(body: unknown): unknown } },
  logBase: NewRequestLog,
  opts: { latencyMs?: number; onError?: (err: unknown, msg: string) => void } = {},
): Promise<boolean> {
  const gate = await checkBudgetHardStop(ctx, orgId);
  // S4: a stop no longer implies a budget ROW — the platform default cap, the
  // platform daily ceiling and the failed-check refusal all stop an org that
  // never configured one. Keying the refusal off `gate.budget` (as this did)
  // would let every new S4 stop serve straight through.
  if (!gate.stopped) return false;
  try {
    await insertRequestLog(ctx.db.db, {
      ...logBase,
      status: 'budget_exceeded',
      ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
    });
  } catch (err) {
    opts.onError?.(err, 'request_logs insert failed');
  }
  const cap = gate.capUsd ?? gate.budget?.monthlyCapUsd ?? 0;
  recordBudgetEvent(ctx.db.db, { orgId, kind: 'budget_exceeded' })
    .then(async (fresh) => {
      if (fresh) {
        await emitAlert(ctx, {
          orgId,
          event: 'budget_exceeded',
          detail: {
            monthlyCapUsd: cap,
            mtdUsd: gate.mtdUsd,
            source: 'serving_path_hard_stop',
            // S4: WHICH stop fired. An operator paged at 3am needs to know
            // whether one customer hit their cap or the platform ceiling
            // just stopped everybody, and those are the same alert without
            // this field.
            reason: gate.reason ?? 'org-cap',
            platformPaid: gate.platformPaid ?? false,
          },
        });
      }
    })
    .catch((err: unknown) => opts.onError?.(err, 'budget alert emit failed — swallowed'));

  // The message says what actually happened. A platform-default stop that
  // claimed "your monthly budget cap" would send a customer looking for a
  // budget they never set.
  const message =
    gate.reason === 'platform-daily-cap'
      ? `platform daily spending ceiling reached: $${formatUsd(gate.mtdUsd)} ≥ $${formatUsd(cap)} ` +
        `across the deployment today — serving resumes at UTC midnight, or raise ${PLATFORM_DAILY_CAP_ENV}`
      : gate.reason === 'check-failed-platform-paid'
        ? 'budget check unavailable — refusing to serve platform-funded traffic without an ' +
          'enforceable cap (this refusal is deliberate: it fails closed when Potion is paying)'
        : gate.reason === 'platform-org-default-cap'
          ? `default spending cap for platform-served orgs reached: MTD $${formatUsd(gate.mtdUsd)} ≥ ` +
            `$${formatUsd(cap)} — set your own cap via PUT /api/budgets, or connect your own ` +
            `provider key to bill your account instead`
          : `monthly budget cap reached (hard stop): MTD $${formatUsd(gate.mtdUsd)} ≥ cap ` +
            `$${formatUsd(cap)} — raise it via PUT /api/budgets`;

  reply.code(429).send(openAiError(message, 'budget_exceeded', 'budget_exceeded'));
  return true;
}

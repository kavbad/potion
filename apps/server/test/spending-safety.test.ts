// SPENDING SAFETY ON OUR OWN KEY (SERVING-ROADMAP S4).
//
// Four holes, every one of them harmless while the CUSTOMER paid and
// dangerous the moment Potion serves from its own provider keys:
//
//   1. an org with NO budget row had NO cap — a freshly self-served org
//      could spend without limit on the platform key;
//   2. the hard-stop check failed OPEN on a db error, so a db hiccup meant
//      unbounded spend for as long as it lasted;
//   3. rate limits were per-API-KEY, so N keys bought N × the limit;
//   4. there was no platform-wide stop-everything switch.
//
// These tests are written to fail if any of those reopens. The load-bearing
// assertions are the NEGATIVE ones — that a BYOK org is NOT newly throttled,
// and that mock mode is NOT changed — because the cheapest way to "fix"
// spending safety is to clamp everybody, and that would break every existing
// customer and every test in this repo for a protection they do not need.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLATFORM_ORG_CAP_USD,
  PLATFORM_DAILY_CAP_ENV,
  PLATFORM_ORG_CAP_ENV,
  checkBudgetHardStop,
  clearBudgetHardStopCache,
  platformDailyCapUsd,
  platformOrgCapUsd,
  platformPaysFor,
} from '../src/routes/budgets.js';
import { ORG_LIMIT_MULTIPLIER, orgRateLimitConfig, DEFAULT_RATE_LIMIT } from '../src/middleware/ratelimit.js';
import type { PotionContext } from '../src/context.js';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [PLATFORM_ORG_CAP_ENV, PLATFORM_DAILY_CAP_ENV]) saved[k] = process.env[k];
  for (const k of [PLATFORM_ORG_CAP_ENV, PLATFORM_DAILY_CAP_ENV]) delete process.env[k];
  clearBudgetHardStopCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearBudgetHardStopCache();
});

/**
 * Exactly what the spending gate reads (budgets.ts): `ctx.providerMode`,
 * `ctx.providersForOrg(orgId).byok`, and `ctx.db.db` (whose contents the
 * vi.mock below interprets). PotionContext is assignable to this, so the stub
 * stays type-checked against the real surface and is widened in one place.
 */
interface BudgetGateCtx {
  providerMode: 'mock' | 'live';
  providersForOrg: (orgId: string) => Promise<{ byok: boolean }>;
  db: { db: unknown };
}

/** A context stub with only what the gate reads. */
function ctxWith(over: {
  providerMode?: 'mock' | 'live';
  byok?: boolean;
  providersThrows?: boolean;
  budget?: { monthlyCapUsd: number; hardStop: boolean } | null;
  budgetThrows?: boolean;
  mtdUsd?: number;
  platformSpendToday?: number;
}): PotionContext {
  const stub: BudgetGateCtx = {
    providerMode: over.providerMode ?? 'live',
    providersForOrg: async () => {
      if (over.providersThrows) throw new Error('provider resolution down');
      return { byok: over.byok ?? false };
    },
    db: {
      db: {
        // getBudget / mtdSpendUsd / platformSpendUsdForDay are module imports;
        // the stub below is installed by the vi.mock at the bottom of the
        // file, so this only needs to be a non-null handle.
        __stub: {
          budget: over.budget ?? null,
          budgetThrows: over.budgetThrows ?? false,
          mtdUsd: over.mtdUsd ?? 0,
          platformSpendToday: over.platformSpendToday ?? 0,
        },
      },
    },
  };
  return stub as PotionContext;
}

vi.mock('@potion/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@potion/db')>();
  const stubOf = (db: unknown): Record<string, unknown> =>
    (db as { __stub: Record<string, unknown> }).__stub;
  return {
    ...actual,
    getBudget: async (db: unknown) => {
      const s = stubOf(db);
      if (s.budgetThrows) throw new Error('db down');
      return s.budget;
    },
    mtdSpendUsd: async (db: unknown) => stubOf(db).mtdUsd,
    platformSpendUsdForDay: async (db: unknown) => stubOf(db).platformSpendToday,
  };
});

// ------------------------------------------------------- who pays ----

describe('platformPaysFor — the fact S4 needs and S3 has not persisted yet', () => {
  it('is FALSE under mock: no real money, so none of the S4 rules apply', async () => {
    expect(await platformPaysFor(ctxWith({ providerMode: 'mock', byok: false }), 'o')).toBe(false);
  });

  it('is TRUE under live for an org with no BYOK key of its own', async () => {
    expect(await platformPaysFor(ctxWith({ providerMode: 'live', byok: false }), 'o')).toBe(true);
  });

  it('is FALSE under live for a BYOK org — their key, their bill', async () => {
    expect(await platformPaysFor(ctxWith({ providerMode: 'live', byok: true }), 'o')).toBe(false);
  });

  it('answers TRUE when it CANNOT TELL — guessing "the customer" is the fail-open we are removing', async () => {
    expect(await platformPaysFor(ctxWith({ providersThrows: true }), 'o')).toBe(true);
  });
});

// ------------------------------------------- hole 1: no cap at all ----

describe('hole 1 — a platform-paid org with no budget row was UNBOUNDED', () => {
  it('now stops at the default cap it never had to configure', async () => {
    const ctx = ctxWith({ budget: null, mtdUsd: DEFAULT_PLATFORM_ORG_CAP_USD + 0.01 });
    const gate = await checkBudgetHardStop(ctx, 'fresh-org');
    expect(gate.stopped).toBe(true);
    expect(gate.reason).toBe('platform-org-default-cap');
    expect(gate.capUsd).toBe(DEFAULT_PLATFORM_ORG_CAP_USD);
  });

  it('serves normally BELOW that cap — the cap bounds, it does not block', async () => {
    const gate = await checkBudgetHardStop(ctxWith({ budget: null, mtdUsd: 1 }), 'fresh-org');
    expect(gate.stopped).toBe(false);
  });

  it('NEVER overrides a cap the customer set for themselves', async () => {
    // Their $500 hard cap wins over our $10 default — in both directions.
    const under = await checkBudgetHardStop(
      ctxWith({ budget: { monthlyCapUsd: 500, hardStop: true }, mtdUsd: 100 }),
      'o1',
    );
    expect(under.stopped).toBe(false); // $100 < $500, despite exceeding our default
    clearBudgetHardStopCache();
    const over = await checkBudgetHardStop(
      ctxWith({ budget: { monthlyCapUsd: 500, hardStop: true }, mtdUsd: 500 }),
      'o2',
    );
    expect(over.stopped).toBe(true);
    expect(over.reason).toBe('org-cap');
  });

  it('leaves a BYOK org exactly as it was — no cap it did not ask for', async () => {
    // The load-bearing negative. Clamping everybody is the cheap fix and it
    // would throttle paying customers for a risk that is not theirs.
    const gate = await checkBudgetHardStop(
      ctxWith({ byok: true, budget: null, mtdUsd: 10_000 }),
      'byok-org',
    );
    expect(gate.stopped).toBe(false);
    expect(gate.platformPaid).toBe(false);
  });

  it('leaves MOCK mode exactly as it was — the protection appears with the risk', async () => {
    const gate = await checkBudgetHardStop(
      ctxWith({ providerMode: 'mock', budget: null, mtdUsd: 10_000 }),
      'mock-org',
    );
    expect(gate.stopped).toBe(false);
  });

  it('honors the env override, and refuses to read a malformed one as "no limit"', async () => {
    process.env[PLATFORM_ORG_CAP_ENV] = '250';
    expect(platformOrgCapUsd()).toBe(250);
    for (const bad of ['abc', '0', '-5', '']) {
      process.env[PLATFORM_ORG_CAP_ENV] = bad;
      expect(platformOrgCapUsd(), `override '${bad}' must not disable the cap`).toBe(
        DEFAULT_PLATFORM_ORG_CAP_USD,
      );
    }
  });
});

// ------------------------------------------ hole 2: fail-open error ----

describe('hole 2 — the check failed OPEN, on our money', () => {
  it('fails CLOSED when Potion is paying', async () => {
    const gate = await checkBudgetHardStop(ctxWith({ budgetThrows: true }), 'o');
    expect(gate.stopped).toBe(true);
    expect(gate.reason).toBe('check-failed-platform-paid');
  });

  it('still fails OPEN for a BYOK org — availability wins on the customer own bill', async () => {
    const gate = await checkBudgetHardStop(ctxWith({ byok: true, budgetThrows: true }), 'o');
    expect(gate.stopped).toBe(false);
  });

  it('still fails OPEN under mock — a broken db must not break the walkthrough', async () => {
    const gate = await checkBudgetHardStop(
      ctxWith({ providerMode: 'mock', budgetThrows: true }),
      'o',
    );
    expect(gate.stopped).toBe(false);
  });

  it('does NOT cache a failure — the next request re-checks rather than being pinned 60s', async () => {
    const ctx = ctxWith({ budgetThrows: true });
    expect((await checkBudgetHardStop(ctx, 'o')).stopped).toBe(true);
    // Same org, db now healthy, cache NOT cleared: a cached refusal would
    // keep refusing for a minute after recovery.
    const healthy = ctxWith({ budget: null, mtdUsd: 0 });
    expect((await checkBudgetHardStop(healthy, 'o')).stopped).toBe(false);
  });
});

// ------------------------------------------ hole 4: the kill switch ----

describe('hole 4 — no platform-wide stop-everything switch', () => {
  it('is OFF unless the operator sets it — a global ceiling is theirs to choose', async () => {
    expect(platformDailyCapUsd()).toBeNull();
    const gate = await checkBudgetHardStop(ctxWith({ platformSpendToday: 1e9 }), 'o');
    expect(gate.stopped).toBe(false);
  });

  it('stops platform-paid serving once the day total crosses it', async () => {
    process.env[PLATFORM_DAILY_CAP_ENV] = '5';
    const gate = await checkBudgetHardStop(ctxWith({ platformSpendToday: 5.01 }), 'o');
    expect(gate.stopped).toBe(true);
    expect(gate.reason).toBe('platform-daily-cap');
    expect(gate.capUsd).toBe(5);
  });

  it('OUTRANKS a generous per-org cap — nothing may sit above the operator switch', async () => {
    process.env[PLATFORM_DAILY_CAP_ENV] = '5';
    const gate = await checkBudgetHardStop(
      ctxWith({ budget: { monthlyCapUsd: 1e6, hardStop: true }, platformSpendToday: 6 }),
      'o',
    );
    expect(gate.stopped).toBe(true);
    expect(gate.reason).toBe('platform-daily-cap');
  });

  it('never stops a BYOK org — their spend is not on the platform ceiling', async () => {
    process.env[PLATFORM_DAILY_CAP_ENV] = '5';
    const gate = await checkBudgetHardStop(
      ctxWith({ byok: true, platformSpendToday: 1e6, budget: null }),
      'o',
    );
    expect(gate.stopped).toBe(false);
  });
});

// ------------------------------------- hole 3: N keys, N × the limit ----

describe('hole 3 — the rate limit was per-KEY, so minting keys bought more of it', () => {
  it('derives an org ceiling that a single key can never reach on its own', async () => {
    const org = orgRateLimitConfig(DEFAULT_RATE_LIMIT);
    expect(org.rps).toBe(DEFAULT_RATE_LIMIT.rps * ORG_LIMIT_MULTIPLIER);
    expect(org.dailyCap).toBe(DEFAULT_RATE_LIMIT.dailyCap * ORG_LIMIT_MULTIPLIER);
    // A legitimate multi-service org must NOT be newly throttled: one key's
    // full allowance stays far below the org ceiling.
    expect(DEFAULT_RATE_LIMIT.rps).toBeLessThan(org.rps);
  });

  it('leaves body size alone — multiplying a per-request ceiling is meaningless', () => {
    expect(orgRateLimitConfig(DEFAULT_RATE_LIMIT).maxBodyKb).toBe(DEFAULT_RATE_LIMIT.maxBodyKb);
  });

  it('bounds the pathological case: 500 keys no longer buy 500x', () => {
    const org = orgRateLimitConfig(DEFAULT_RATE_LIMIT);
    const withoutCeiling = DEFAULT_RATE_LIMIT.dailyCap * 500;
    expect(org.dailyCap).toBeLessThan(withoutCeiling);
  });
});

describe('formatUsd — the refusal has to stay legible at small thresholds', () => {
  it('shows sub-cent amounts instead of flattening them to $0.00', async () => {
    const { formatUsd } = await import('../src/routes/budgets.js');
    // The live leg returned "platform daily spending ceiling reached:
    // $0.00 ≥ $0.00" — true, useless, and alarming. Small caps are exactly
    // the ones a cautious operator sets first.
    expect(formatUsd(0.000214)).toBe('0.000214');
    expect(formatUsd(0.0002)).toBe('0.0002');
    expect(formatUsd(0)).toBe('0.00');
    // …and dollars still read as dollars.
    expect(formatUsd(12.5)).toBe('12.50');
    expect(formatUsd(0.02)).toBe('0.02');
  });
});

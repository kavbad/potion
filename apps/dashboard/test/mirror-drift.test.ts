// THE MIRROR-DRIFT GUARD.
//
// apps/dashboard/lib/types.ts holds LOCAL MIRRORS of the server's API shapes,
// on purpose: the dashboard talks HTTP and stays dependency-free. The cost of
// that choice is that a mirror can go stale, and a stale mirror does not fail
// loudly — it makes a switch "exhaustive" over the WRONG union, which
// type-checks while rendering nothing.
//
// That is not hypothetical. `composite` shipped in M3 #23 and was never added
// to the mirror, so describeStrategy returned undefined for it — and the
// operating-point sentence, the hover card and the PUBLIC share page rendered
// an empty span for a real strategy, for months. No test caught it because
// every test used shapes the mirror already knew.
//
// So the guard reads the SERVER's schemas — the real ones, from @potion/core,
// a dev dependency used here and nowhere in the shipped bundle — and asserts
// the dashboard can describe every shape they admit. Add a strategy type or a
// policy type server-side without teaching the dashboard, and this fails by
// name instead of quietly blanking a page.
import { describe, expect, it } from 'vitest';
import { PolicySchema, StrategyConfigSchema, type StrategyConfig } from '@potion/core';
import { describeStrategy } from '../lib/frontier-chart';

/** The `type` literals a zod discriminated union actually admits.
 *
 *  Narrowed with plain `as`, never laundered through `as never`: zod's option
 *  tuple is precisely typed and reading one field off it structurally is what
 *  this needs, so say that rather than erasing the type entirely. */
function discriminants(schema: { readonly options: readonly unknown[] }): string[] {
  return schema.options
    .map((option) => {
      const shape = (option as { shape?: Record<string, unknown> }).shape;
      const literal = shape?.['type'] as { value?: unknown } | undefined;
      return String(literal?.value);
    })
    .sort();
}

const STRATEGY_TYPES = discriminants(StrategyConfigSchema);
const POLICY_TYPES = discriminants(PolicySchema);

/** One valid instance per server-admitted type. The map is the second half of
 *  the guard: a new server type has no fixture, the coverage check below says
 *  so, and someone has to make a DECISION about how the dashboard shows it. */
const SAMPLE: Record<string, StrategyConfig> = {
  single: { type: 'single', model: 'gpt-mini-class' },
  cascade: { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'logprob' },
  'best-of-n': { type: 'best-of-n', model: 'a', n: 3, judge: { model: 'j' } },
  'draft-verify': { type: 'draft-verify', draftModel: 'a', verifierModel: 'b' },
  ensemble: { type: 'ensemble', models: ['a', 'b'], fusion: { method: 'judge-pick' } },
  decompose: { type: 'decompose', decomposerModel: 'd', routing: { default: 'a' } },
  composite: { type: 'composite', startModel: 'a', upgradeModel: 'b', upgradeIf: { confidenceBelow: 0.6 } },
  program: { type: 'program', name: 'verified-cascade', body: { op: 'call', model: 'a' } },
};

describe('the dashboard mirror has not drifted from the server', () => {
  it('has a sample for every strategy type the server admits', () => {
    expect(STRATEGY_TYPES.length).toBeGreaterThan(0);
    expect(STRATEGY_TYPES.filter((t) => SAMPLE[t] === undefined)).toEqual([]);
  });

  it('describes every strategy type the server can serve, rather than naming it', () => {
    const undescribed = STRATEGY_TYPES.filter((t) => {
      const out = describeStrategy(SAMPLE[t]!);
      return out === undefined || out.startsWith('Strategy · ');
    });
    expect(
      undescribed,
      `the server can serve these and the dashboard would render only their type name: ${undescribed.join(', ')}. ` +
        'Add them to apps/dashboard/lib/types.ts AND to describeStrategy.',
    ).toEqual([]);
  });

  it('knows every policy type the server can bind', () => {
    // ruleInWords in components/frontier-chart.tsx switches over the mirrored
    // Policy union with no fallback — the same structure that blanked
    // composite. Pinning the type list here means adding a server policy type
    // without teaching the dashboard fails HERE rather than on a customer's
    // screen.
    expect(POLICY_TYPES).toEqual(['compound', 'latency_bound', 'max_quality', 'min_cost']);
  });

  it('and the strategy list is pinned, so a new server shape is a decision not a surprise', () => {
    expect(STRATEGY_TYPES).toEqual([
      'best-of-n', 'cascade', 'composite', 'decompose', 'draft-verify', 'ensemble', 'program', 'single',
    ]);
  });
});

// The router page's hero rule. Reversed once already (dollars → ratio on
// 2026-09-01, ratio → dollars on 2026-09-04), so the branches are pinned here
// with the reason each one exists — the next person to change it should have
// to change a test that says why.
import { describe, expect, it } from 'vitest';
import { heroDecision } from '../lib/savings-hero';

const base = { actualSpend: 12, baselineSpend: 100, incumbentModels: [] as string[] };

describe('what leads the router page', () => {
  it('a NAMED incumbent earns the dollar figure — the baseline is a model they actually ran', () => {
    const d = heroDecision({ ...base, incumbentModels: ['or-gpt-full'] });
    expect(d.mode).toBe('dollars');
    expect(d.comparator).toBe('or-gpt-full');
    expect(d.namedIncumbent).toBe(true);
  });

  it('a free-text incumbent counts too — the org told us what it runs', () => {
    const d = heroDecision({ ...base, otherIncumbent: 'our fine-tuned llama' });
    expect(d.mode).toBe('dollars');
    expect(d.comparator).toBe('our fine-tuned llama');
  });

  it('several named models are summarised rather than listed in the hero line', () => {
    const d = heroDecision({ ...base, incumbentModels: ['or-gpt-full', 'or-sonnet'] });
    expect(d.mode).toBe('dollars');
    expect(d.comparator).toBe('the 2 models you named');
  });

  it('NO named incumbent keeps the ratio — this is the 2026-09-01 objection', () => {
    // The baseline here is the premium pick, not something the customer was
    // going to buy. Dollars against it is the number the operator rejected.
    const d = heroDecision(base);
    expect(d.mode).toBe('ratio');
    expect(d.comparator).toBe('the best scorer');
    expect(d.namedIncumbent).toBe(false);
  });

  it('spending MORE than the comparator is a LOSS, never a clamped "$0 saved" (2026-09-11)', () => {
    // The screen that found it: spent $3.46 where it would have billed
    // $2.68, headlined "$0.0000 saved". A loss renders as a loss.
    const d = heroDecision({ ...base, actualSpend: 3.46, baselineSpend: 2.68 });
    expect(d.mode).toBe('loss');
    expect(d.comparator).toBe('the best scorer');
    // …and a named incumbent does not turn a loss into dollars saved.
    expect(heroDecision({ ...base, actualSpend: 3.46, baselineSpend: 2.68, incumbentModels: ['or-sonnet'] }).mode).toBe('loss');
    // exact break-even is not a loss
    expect(heroDecision({ ...base, actualSpend: 2.68, baselineSpend: 2.68 }).mode).toBe('ratio');
  });

  it('no baseline recorded: the kept counter leads, named incumbent or not', () => {
    expect(heroDecision({ ...base, baselineSpend: 0 }).mode).toBe('kept-only');
    expect(heroDecision({ ...base, baselineSpend: 0, incumbentModels: ['or-sonnet'] }).mode).toBe('kept-only');
  });

  it('nothing spent yet: still kept-only, so day one cannot print a ratio out of nothing', () => {
    expect(heroDecision({ ...base, actualSpend: 0 }).mode).toBe('kept-only');
    expect(heroDecision({ ...base, actualSpend: 0, incumbentModels: ['or-sonnet'] }).mode).toBe('kept-only');
  });

  it('a comparator is always available, even in the states that do not show one', () => {
    for (const d of [
      heroDecision(base),
      heroDecision({ ...base, baselineSpend: 0 }),
      heroDecision({ ...base, actualSpend: 0, incumbentModels: ['or-sonnet'] }),
    ]) {
      expect(d.comparator.length).toBeGreaterThan(0);
    }
  });
});

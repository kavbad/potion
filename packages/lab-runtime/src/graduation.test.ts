// L-G1 evaluator tests. The two hard cases from the 2026-08-26 external
// review are pinned by name: risk-aware graduation is the product, and
// these are the sentences it must encode rather than round past.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_RATE_FLOOR,
  auditRateFor,
  graduationDecision,
  type ActionEvidence,
} from './graduation.js';

const NOW = new Date('2026-08-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function ev(
  outcome: ActionEvidence['outcome'],
  opts: { highStakes?: boolean; at?: Date; fromAudit?: boolean } = {},
): ActionEvidence {
  return { at: opts.at ?? daysAgo(5), outcome, highStakes: opts.highStakes ?? false, fromAudit: opts.fromAudit };
}

const many = (n: number, f: () => ActionEvidence) => Array.from({ length: n }, f);

describe('the review’s hard cases, pinned', () => {
  it('97 approved / 3 rejected Salesforce updates does NOT graduate when the 3 failures were high-value records', () => {
    const evidence = [
      ...many(97, () => ev('approved')),
      ...many(3, () => ev('rejected', { highStakes: true })),
    ];
    const d = graduationDecision({ tier: 'reversible-act', state: 'supervised', evidence, now: NOW });
    expect(d.kind).toBe('hold');
    expect(d.why).toContain('high-stakes');
    // The same record with ROUTINE failures also holds — but on EVIDENCE
    // grounds (the interval), not the veto. The distinction is the design:
    // routine failures are an uncertainty problem; high-stakes failures are
    // a consequence problem, and no additional volume cures the latter.
    const routine = [...many(97, () => ev('approved')), ...many(3, () => ev('rejected', { at: daysAgo(40) }))];
    const d2 = graduationDecision({ tier: 'reversible-act', state: 'supervised', evidence: routine, now: NOW });
    expect(d2.kind).toBe('hold');
    expect(d2.why).toContain('lower bound');
    expect(d2.why).not.toContain('high-stakes');
  });

  it('999 correct refunds and one wrong $100,000 refund is 99.9% and UNACCEPTABLE — an autonomous class tightens', () => {
    const evidence = [
      ...many(999, () => ev('validated', { fromAudit: true })),
      ev('reversed', { highStakes: true, at: daysAgo(2) }),
    ];
    const d = graduationDecision({ tier: 'irreversible-act', state: 'autonomous', evidence, now: NOW });
    expect(d.kind).toBe('tighten');
  });
});

describe('risk tiers scale the evidence bar', () => {
  it('30 clean observations graduate reversible-read but hold irreversible-act', () => {
    const evidence = many(30, () => ev('approved'));
    expect(graduationDecision({ tier: 'reversible-read', state: 'supervised', evidence, now: NOW }).kind).toBe('propose-graduate');
    expect(graduationDecision({ tier: 'irreversible-act', state: 'supervised', evidence, now: NOW }).kind).toBe('hold');
  });

  it('never-graduates refuses a PERFECT record — no success rate argues with the tier', () => {
    const evidence = many(1000, () => ev('validated'));
    const d = graduationDecision({ tier: 'never-graduates', state: 'supervised', evidence, now: NOW });
    expect(d.kind).toBe('never');
  });

  it('uncertainty is boundary-honest: enough n with a clean record clears; the same rate at small n does not', () => {
    // 25/25 perfect → Jeffreys lower ≈0.905 clears the reversible-read 0.90
    // floor; 10/10 perfect (lower ≈0.783) does not, despite the same 100% rate.
    expect(graduationDecision({ tier: 'reversible-read', state: 'supervised', evidence: many(25, () => ev('approved')), now: NOW }).kind).toBe('propose-graduate');
    const small = graduationDecision({ tier: 'reversible-read', state: 'supervised', evidence: many(10, () => ev('approved')), now: NOW });
    expect(small.kind).toBe('hold');
  });
});

describe('the asymmetry: tighten automatically, loosen only by proposal', () => {
  it('a rejection burst inside 14d re-supervises an autonomous class', () => {
    const evidence = [
      ...many(300, () => ev('validated', { at: daysAgo(20) })),
      ev('edited', { at: daysAgo(3) }),
      ev('rejected', { at: daysAgo(1) }),
    ];
    const d = graduationDecision({ tier: 'reversible-act', state: 'autonomous', evidence, now: NOW });
    expect(d.kind).toBe('tighten');
    expect(d.why).toContain('drift');
  });

  it('a clean record never AUTO-grants: the strongest verdict is a proposal', () => {
    const evidence = many(400, () => ev('validated'));
    const d = graduationDecision({ tier: 'irreversible-act', state: 'supervised', evidence, now: NOW });
    expect(d.kind).toBe('propose-graduate');
    // and an autonomous class in good standing just holds — no further loosening exists
    const d2 = graduationDecision({ tier: 'irreversible-act', state: 'autonomous', evidence, now: NOW });
    expect(d2.kind).toBe('hold');
  });

  it('an edit counts as a failure label (the human had to fix it)', () => {
    const evidence = [...many(76, () => ev('approved')), ...many(24, () => ev('edited', { at: daysAgo(40) }))];
    const d = graduationDecision({ tier: 'reversible-act', state: 'supervised', evidence, now: NOW });
    expect(d.kind).toBe('hold'); // 76% validated lower bound is nowhere near 0.95
  });
});

describe('the audit floor: unaudited autonomy is unmeasured autonomy', () => {
  it('autonomous classes keep a permanent sampling floor; supervised are fully observed', () => {
    expect(auditRateFor('autonomous', 0)).toBe(AUDIT_RATE_FLOOR);
    expect(auditRateFor('autonomous', 0.5)).toBe(0.5);
    expect(auditRateFor('supervised')).toBe(1);
    expect(auditRateFor('blocked')).toBe(1);
  });

  it('evidence outside the tier window does not count toward graduation', () => {
    const stale = many(200, () => ev('approved', { at: daysAgo(120) }));
    const d = graduationDecision({ tier: 'reversible-act', state: 'supervised', evidence: stale, now: NOW });
    expect(d.kind).toBe('hold');
    expect(d.why).toContain('0 of 80');
  });
});

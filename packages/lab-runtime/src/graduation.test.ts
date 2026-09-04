// L-G1 evaluator tests. The two hard cases from the 2026-08-26 external
// review are pinned by name: risk-aware graduation is the product, and
// these are the sentences it must encode rather than round past.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_RATE_FLOOR,
  auditRateFor,
  effectiveEvidence,
  graduationDecision,
  REPEAT_EVIDENCE_CAP,
  type ActionEvidence,
} from './graduation.js';

const NOW = new Date('2026-08-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

// Each fabricated observation is a DISTINCT situation unless a test pins
// sameness — the diversity dimension (v3) is what the narrow-distribution
// tests exercise explicitly.
let sitCounter = 0;
function ev(
  outcome: ActionEvidence['outcome'],
  opts: { highStakes?: boolean; at?: Date; fromAudit?: boolean; situation?: string } = {},
): ActionEvidence {
  sitCounter += 1;
  return {
    at: opts.at ?? daysAgo(5),
    outcome,
    highStakes: opts.highStakes ?? false,
    // exactOptionalPropertyTypes: an optional field must be ABSENT, not
    // present-and-undefined — the two are different states to anything that
    // checks with `in`.
    ...(opts.fromAudit !== undefined ? { fromAudit: opts.fromAudit } : {}),
    situation: opts.situation ?? `sit-${sitCounter}`,
  };
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

describe('diversity (v3): volume is not trust', () => {
  it('“25 nearly identical successful actions may prove very little” — 40 approvals of ONE situation hold', () => {
    const narrow = many(40, () => ev('approved', { situation: 'same-call' }));
    const d = graduationDecision({ tier: 'reversible-read', state: 'supervised', evidence: narrow, now: NOW });
    expect(d.kind).toBe('hold');
    expect(d.why).toContain('distinct situation');
    // The SAME count spread across distinct situations proposes.
    const diverse = many(40, () => ev('approved'));
    const d2 = graduationDecision({ tier: 'reversible-read', state: 'supervised', evidence: diverse, now: NOW });
    expect(d2.kind).toBe('propose-graduate');
    if (d2.kind === 'propose-graduate') {
      expect(d2.evidence.distinctSituations).toBe(40);
      expect(d2.evidence.effectiveN).toBe(40);
    }
  });

  it('unattributed evidence collapses into one shared bucket — conservative by construction', () => {
    const unattributed: ActionEvidence[] = Array.from({ length: 40 }, () => ({
      at: daysAgo(5), outcome: 'approved', highStakes: false,
    }));
    const d = graduationDecision({ tier: 'reversible-read', state: 'supervised', evidence: unattributed, now: NOW });
    expect(d.kind).toBe('hold');
  });

  it('the cap governs earning, never signal: failures are never discounted', () => {
    const eff = effectiveEvidence([
      ...many(10, () => ev('approved', { situation: 'same' })),
      ...many(10, () => ev('rejected', { situation: 'same' })),
    ]);
    // successes cap at REPEAT_EVIDENCE_CAP; every failure counts.
    expect(eff.scores.filter((s) => s === 1).length).toBe(REPEAT_EVIDENCE_CAP);
    expect(eff.scores.filter((s) => s === 0).length).toBe(10);
    expect(eff.distinctSituations).toBe(1);
  });

  it('an autonomous class is never tightened for narrowness — raw evidence drives the drift check', () => {
    const narrow = many(300, () => ev('validated', { situation: 'same-call', fromAudit: true }));
    const d = graduationDecision({ tier: 'reversible-act', state: 'autonomous', evidence: narrow, now: NOW });
    expect(d.kind).toBe('hold');
    expect(d.why).toContain('holding its floor');
  });
});

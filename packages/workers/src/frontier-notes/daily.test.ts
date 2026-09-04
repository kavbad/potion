// The daily ledger (F6) — the number law, the quiet day, and the shape.
import { describe, expect, it } from 'vitest';
import { assembleDailyIssue, auditDailyNumbers, composeDailyFacts, dailyLedgerBody, deterministicDailyDraft, shortPricesLabel, utcDay } from './daily.js';

const NOW = new Date('2026-09-03T12:00:00Z');
const rows = [
  { focusAlias: 'or-new-model-a', status: 'complete', provenance: 'live', candidates: 6, spendUsd: 1.25, createdAt: '2026-09-03T04:00:00Z' },
  { focusAlias: null, status: 'complete', provenance: 'mock', candidates: 4, spendUsd: 0, createdAt: '2026-09-02T20:00:00Z' },
  { focusAlias: 'or-stale', status: 'complete', provenance: 'live', candidates: 3, spendUsd: 9, createdAt: '2026-08-20T20:00:00Z' }, // outside window
];

const busy = composeDailyFacts({ now: NOW, cycles: rows, promoted: 1, registrySize: 322, pricesVersion: 'p-2026-09-01' });
const quiet = composeDailyFacts({ now: NOW, cycles: [], promoted: 0, registrySize: 322, pricesVersion: 'p-2026-09-01' });

describe('composing the day', () => {
  it('counts only the last 24 hours and sums the real spend', () => {
    expect(busy.day).toBe('2026-09-03');
    expect(busy.cycles).toHaveLength(2);
    expect(busy.measured).toEqual(['or-new-model-a']);
    expect(busy.spendUsd).toBe(1.25);
    expect(busy.quiet).toBe(false);
    expect(utcDay(NOW)).toBe('2026-09-03');
  });

  it('a day with nothing measured is quiet, and says so as a result', () => {
    expect(quiet.quiet).toBe(true);
    const d = deterministicDailyDraft(quiet);
    expect(d.title).toMatch(/quiet day/i);
    expect(dailyLedgerBody(quiet)[0]).toMatch(/No measurement cycle ran/);
    expect(d.takeaway).toMatch(/knowing that for certain/);
  });

  it('the ledger states the instruments’ own counts', () => {
    const body = dailyLedgerBody(busy).join(' ');
    expect(body).toContain('2 measurement cycles');
    expect(body).toContain('10 candidate configurations');
    // THE OWN-SPEND LAW: what the sweep cost US is no longer printed.
    expect(body).not.toContain('$1.25');
    expect(body).not.toMatch(/\$\d/);
    expect(body).toContain('322 models');
  });
});

describe('the prices label', () => {
  it('never prints the append log — it carries withheld names and held the first live daily', () => {
    const real = '2026-08-04-or2+tranche-2026-08-19+or-solar-pro4+or-hy4-preview+or-glm-latest';
    expect(shortPricesLabel(real)).toBe('2026-08-04-or2 plus 4 revisions');
    expect(shortPricesLabel(real)).not.toContain('or-solar-pro4');
    expect(shortPricesLabel('p-2026-09-01')).toBe('p-2026-09-01');
    const facts = composeDailyFacts({ now: NOW, cycles: [], promoted: 0, registrySize: 375, pricesVersion: real });
    const body = dailyLedgerBody(facts).join(' ');
    expect(body).not.toContain('or-solar-pro4');
    expect(body).toContain('375 models');
  });
});

describe('THE NUMBER LAW', () => {
  it('passes prose whose figures are all in the ledger', () => {
    expect(auditDailyNumbers(deterministicDailyDraft(busy), busy)).toBeNull();
    expect(auditDailyNumbers(deterministicDailyDraft(quiet), quiet)).toBeNull();
  });

  it('refuses an invented figure', () => {
    const bad = { ...deterministicDailyDraft(busy), plain: 'The instruments swept 47 candidates today.' };
    expect(auditDailyNumbers(bad, busy)).toMatch(/"47".*not a number in today/);
  });

  it('refuses derived ratios outright — the ledger reports counts and dollars', () => {
    const pct = { ...deterministicDailyDraft(busy), takeaway: 'Costs fell 30% today.' };
    expect(auditDailyNumbers(pct, busy)).toMatch(/derived ratio/);
    const times = { ...deterministicDailyDraft(busy), takeaway: 'A combination was 8× cheaper.' };
    expect(auditDailyNumbers(times, busy)).toMatch(/derived ratio/);
  });

  it('allows the date parts, and no longer permits our own spend figure', () => {
    const ok = { ...deterministicDailyDraft(busy), plain: 'On 2026-09-03 the instruments measured 2 cycles.' };
    expect(auditDailyNumbers(ok, busy)).toBeNull();
    // The spend is not in the ledger any more, so stating it is a
    // fabrication as far as the number law is concerned — belt and braces
    // with the own-spend law itself.
    const spendy = { ...deterministicDailyDraft(busy), plain: 'The instruments spent $1.25 today.' };
    expect(auditDailyNumbers(spendy, busy)).toMatch(/"1\.25"/);
  });
});

describe('assembly', () => {
  it('produces a daily issue: body paragraphs, no facts, no faq, addressed by day', () => {
    const issue = assembleDailyIssue(busy, deterministicDailyDraft(busy), { publishedAt: NOW.toISOString(), writer: null });
    expect(issue.status).toBe('published');
    expect(issue.kind).toBe('daily');
    expect(issue.week).toBe('2026-09-03');
    expect(issue.slug).toBe('2026-09-03');
    expect(issue.facts).toBeNull();
    expect(issue.faq).toEqual([]);
    expect(issue.body!.length).toBeGreaterThan(1);
    expect(issue.byline).toBe('Potion Research');
  });

  it('carries the Delta byline and run record when a framing run supplied the prose', () => {
    const issue = assembleDailyIssue(busy, deterministicDailyDraft(busy), {
      publishedAt: NOW.toISOString(),
      byline: 'Delta',
      writer: { model: 'delta:abc', costUsd: 0.002, runId: 'run-d1' },
    });
    expect(issue.byline).toBe('Delta');
    expect(issue.writer?.runId).toBe('run-d1');
  });
});

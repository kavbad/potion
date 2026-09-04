// THE OWN-SPEND LAW: a model's price to a reader is the product; Potion's
// own operating spend never appears. The line between them is the whole
// point, so both sides are tested.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditNoOwnSpend, lintDraft } from './lint.js';
import { renderMarkdown, writeIssue } from './publish.js';
import { redactFactsForWriter } from './delta.js';
import type { FactSheet } from './types.js';

const draft = (over: Partial<Record<string, string>> = {}) => ({
  title: 'A finding.',
  summary: 's',
  plain: 'p',
  lede: 'l',
  frontierNote: 'f',
  auditionNote: 'a',
  mixingNote: '',
  takeaway: 't',
  faq: [],
  ...over,
});

describe('the own-spend law', () => {
  it('refuses every way of saying what WE spent', () => {
    for (const s of [
      'We spent $0.91 running this week.',
      'The week cost $0.91 to run.',
      'Our spend for the month was small.',
      'The measurements cost us $12.',
      'The measurement budget was $50.',
      'Total spending was $4.10 for the sweep.',
      '$0.91 to run the checks.',
    ]) {
      expect(auditNoOwnSpend(s), s).not.toBeNull();
    }
  });

  it('leaves MODEL prices completely alone — that is the product', () => {
    for (const s of [
      'One model scored 1.000 at $6.85 per thousand requests while another scored 0.979 at $0.0232.',
      'The cheapest model that clears 0.95 costs $0.0042 per thousand requests.',
      'At one million requests that difference becomes $6,233.70 of your spend.',
      'Tool-calling models are priced 300× apart, from $0.35 to $105 per million tokens.',
    ]) {
      expect(auditNoOwnSpend(s), s).toBeNull();
    }
  });

  it('is enforced by the style lint, so no draft path can skip it', () => {
    expect(lintDraft(draft({ lede: 'We spent $0.91 on the canaries.' }))).toMatch(/never published/);
    expect(lintDraft(draft({ lede: 'A model at $6.85 per thousand requests scored 1.000.' }))).toBeNull();
  });

  it('the figure never even reaches the writer', () => {
    const facts = {
      week: '2026-W36',
      at: '',
      frontier: [],
      auditions: [],
      mixing: [],
      numbers: { canaries: 10, clustersHeld: 8, clustersMoved: 2, inconclusive: 0, itemsGraded: 40, candidatesScreened: 322, candidatesMeasured: 3, spendUsd: 0.91 },
      caveats: [],
    } satisfies FactSheet;
    const seen = JSON.stringify(redactFactsForWriter(facts));
    expect(seen).not.toContain('0.91');
    expect(seen).not.toContain('spendUsd');
    expect(seen).toContain('"canaries":10');
  });
});

// The provenance footer published "$0.0031 metered" under every piece —
// a figure the writer never wrote, printed by the template (found live
// 2026-09-04). The law now runs over the rendered page, not just the draft.
describe('the own-spend law reaches the rendered page', () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    slug: '2026-09-04', week: '2026-09-04', kind: 'daily' as const,
    title: 'A finding.', summary: 's', body: 'One paragraph.',
    publishedAt: '2026-09-04T17:00:00.000Z', byline: 'Potion Research',
    plain: 'p', lede: 'l', frontierNote: '', auditionNote: '', mixingNote: '', takeaway: 't',
    method: 'm', faq: [], facts: null,
    writer: { model: 'w', costUsd: 0.0031, runId: 'run-abc' },
    status: 'published' as const,
    ...over,
  });

  it('never prints what the writer run cost us', () => {
    const md = renderMarkdown(issue() as never);
    expect(md).toContain('run-abc');
    expect(md).not.toMatch(/\$[\d.]+/);
    expect(auditNoOwnSpend(md)).toBeNull();
  });

  it('holds an issue whose rendered page states our spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
    writeIssue(dir, issue({ body: 'The run cost us $0.31 to produce.' }) as never);
    const written = JSON.parse(readFileSync(join(dir, '2026-09-04.json'), 'utf8')) as { status: string; heldReason?: string };
    expect(written.status).toBe('held');
    expect(written.heldReason).toMatch(/never published/);
  });
});

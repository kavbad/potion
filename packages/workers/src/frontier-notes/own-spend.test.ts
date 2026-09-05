// THE OWN-SPEND LAW: a model's price to a reader is the product; Potion's
// own operating spend never appears. The line between them is the whole
// point, so both sides are tested.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditNoOwnSpend, auditRepetition, lintDraft } from './lint.js';
import { renderMarkdown, writeIssue } from './publish.js';
import { redactFactsForWriter } from './delta.js';
import type { FactSheet, Issue } from './types.js';

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
  const issue = (over: Partial<Issue> = {}): Issue => ({
    slug: '2026-09-04', week: '2026-09-04', kind: 'daily',
    title: 'A finding.', summary: 's', body: 'One paragraph.',
    publishedAt: '2026-09-04T17:00:00.000Z', byline: 'Potion Research',
    plain: 'p', lede: 'l', frontierNote: '', auditionNote: '', mixingNote: '', takeaway: 't',
    method: 'm', faq: [], facts: null,
    writer: { model: 'w', costUsd: 0.0031, runId: 'run-abc' },
    status: 'published',
    ...over,
  });

  it('never prints what the writer run cost us', () => {
    const md = renderMarkdown(issue());
    expect(md).toContain('run-abc');
    expect(md).not.toMatch(/\$[\d.]+/);
    expect(auditNoOwnSpend(md)).toBeNull();
  });

  it('holds an issue whose rendered page states our spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
    writeIssue(dir, issue({ body: 'The run cost us $0.31 to produce.' }));
    const written = JSON.parse(readFileSync(join(dir, '2026-09-04.json'), 'utf8')) as { status: string; heldReason?: string };
    expect(written.status).toBe('held');
    expect(written.heldReason).toMatch(/never published/);
  });
});

// THE SECOND-PARAGRAPH LAW (operator, 2026-09-05: "fix delta's repetitive
// prose"). The fixture is the REAL published piece from run-5834835a.
describe('the second-paragraph law', () => {
  const published = {
    plain:
      'The measurement compared two models on the same agentic-tool-use suite of 14 tasks. One model, gpt-5.6-terra-pro, scored 0.972 quality at $44.15 per thousand requests. The cheaper model, ling-3.0-flash, scored 0.886 quality at $0.1094 per thousand requests. The gap between them is 8.7 quality points and a 404× cost difference.',
    lede:
      'On a suite of 14 measured agentic-tool-use tasks, gpt-5.6-terra-pro reached 0.972 quality at $44.15 per thousand requests. ling-3.0-flash reached 0.886 quality at $0.1094 per thousand requests. The quality gap is 8.7 points and the cost ratio is about 404×.',
    takeaway:
      'An engineer paying per request should use ling-3.0-flash at $0.1094 per thousand requests when 0.886 quality is enough, and reserve gpt-5.6-terra-pro at $44.15 per thousand requests for the task fraction that needs the extra 8.7 points.',
  };

  it('refuses the piece that shipped: paragraph two was paragraph one again', () => {
    expect(auditRepetition(published)).toMatch(/second paragraph restates the finding/);
  });

  it('lets the second paragraph REFER to a figure while making its own point', () => {
    expect(
      auditRepetition({
        ...published,
        lede: 'Price is set by what a provider can charge, not by what a model scores. The extra 8.7 points are the only thing the premium buys, and only on work resembling this suite.',
      }),
    ).toBeNull();
  });

  it('does not punish a takeaway for naming the options it recommends', () => {
    expect(auditRepetition({ ...published, lede: 'The gap is a property of the models, not of the test.' })).toBeNull();
  });

  it('catches the same sentence used in two paragraphs', () => {
    const s = 'The gap between them is 8.7 quality points and a 404 times cost difference.';
    expect(auditRepetition({ plain: `A finding. ${s}`, lede: `${s} And more.`, takeaway: 't' })).toMatch(/same sentence appears/);
  });
});

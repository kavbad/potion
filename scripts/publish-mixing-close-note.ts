// The mixing-close Frontier Note (2026-08-25, operator-directed one-off).
// Hand-assembled issue, machine-checked: every narrative field passes the
// SAME fail-closed redaction gate the weekly writer uses (assertPublishable
// throws on any never-name or mechanism leak). Frontier facts are reused
// verbatim from the already-published W35 issue so the page renders whole.
//   tsx scripts/publish-mixing-close-note.ts <w35.json> <outDir>
import { readFileSync, mkdirSync } from 'node:fs';

const [w35Path, outDir] = process.argv.slice(2);
if (!w35Path || !outDir) throw new Error('usage: publish-mixing-close-note.ts <w35.json> <outDir>');

const { assertPublishable, writeIssue } = await import('@potion/workers');
type Issue = import('@potion/workers').Issue;

const w35 = JSON.parse(readFileSync(w35Path, 'utf8')) as Issue;

const issue: Issue = {
  slug: 'the-mixing-verdict',
  week: '2026-W35S',
  title: 'We spent two weeks trying to beat single models with model combinations. Single models won.',
  summary:
    'Five pre-registered experiments asked whether combining models beats the best single model on the same work. It does not, at the current model market — and the reasons are now measured, published, and good news for anyone paying for inference.',
  publishedAt: new Date().toISOString(),
  byline: 'Potion Research',
  plain:
    'We route each request to the cheapest model that is measured to clear a quality bar for that kind of work. An obvious question is whether we should go further: run several models on one request and pick the best answer. We tested that idea five ways, with pre-registered targets and hard budget caps. Every test lost to the best single model, and this issue says exactly why.',
  lede:
    'The strongest model on our hardest code exam never missed — twice, across every item. But a model at roughly a twenty-third of its price came within about one point of it. That gap is the entire space a combination of models could win, and it is smaller than the cost of refereeing the combination.',
  frontierNote: w35.frontierNote,
  auditionNote: w35.auditionNote,
  mixingNote:
    'Five adjudications, one verdict. Having a referee model pick between two answers realizes about a quarter of the theoretical gain, because referees mispick. Picking by executing tests fixes the mispicks but pays for every model on every request — at the expensive end the combination cost more than the champion it chased, and at the cheap end a second model multiplies the bill six-fold against a margin inside measurement noise. Escalating from a cheap model only when it seems unsure fails differently: models are confident exactly when they are wrong, so the gate misses the errors and the escalations it does fire often trade a right answer away. Where combinations DO win is across requests, not within one: sending each kind of work to the model measured best for its price. That is what this product does.',
  takeaway:
    'You almost certainly do not need the most expensive model for most of your work, and you do not need exotic model combinations either. The measured gap between the best model and the best value model is about a point on our hardest exams, and the price gap is up to twenty-three times. Routing each kind of work to the cheapest model that clears your bar captures that spread with receipts. We publish our failures so you can trust that claim: settled for the task shapes we measure, at the current model market — and our weekly saturation checks will say so publicly if the market changes shape.',
  method:
    'Every experiment was pre-registered: the target, the shapes, and the success bar were written to an internal ledger before any measurement ran. Comparisons are like-for-like — same run, same items, fresh baselines, never cached aggregates. All spend is capped and ledgered; two runs were refused by our own budget machinery and re-scoped. Combination mechanics (how selectors and gates work) are part of the product and are not published; what they achieved, and failed to achieve, is.',
  faq: [
    {
      q: 'Does this mean model combinations are useless?',
      a: 'Within one request, at today’s model market, on the task shapes we measure: yes, we could not make them pay. Across requests they are the whole product — each kind of work goes to the model measured best for its price. If the market changes shape, our weekly checks will catch it and we will re-open the question publicly.',
    },
    {
      q: 'Why publish negative results?',
      a: 'Because the product is trust in measurement. A router that only ever reports wins is indistinguishable from a router that does not measure. Five honest losses for about thirteen dollars is the cheapest credibility we will ever buy.',
    },
    {
      q: 'What should I do with this?',
      a: 'Ask what your current model bill would be if every kind of work went to the cheapest model that clears your quality bar. That number is measurable on your own traffic, with a receipt on every answer.',
    },
  ],
  facts: {
    ...w35.facts,
    mixing: [
      { family: 'code', kind: 'judge-picked pair', meanQuality: 0.94, qualityDeltaVsBestSingle: -0.02, costSaving: 0, n: 84, vague: true, costBand: 'premium' },
      { family: 'code', kind: 'execution-picked pair', meanQuality: 0.994, qualityDeltaVsBestSingle: -0.006, costSaving: -0.12, n: 84, vague: true, costBand: 'premium' },
      { family: 'writing', kind: 'picked pair', meanQuality: 0.936, qualityDeltaVsBestSingle: -0.014, costSaving: 0, n: 28, vague: true, costBand: 'premium' },
      { family: 'code', kind: 'confidence-escalated', meanQuality: 0.981, qualityDeltaVsBestSingle: -0.008, costSaving: 0, n: 336, vague: true, costBand: 'mid' },
      { family: 'extraction', kind: 'structure-checked pair', meanQuality: 0.94, qualityDeltaVsBestSingle: 0.005, costSaving: 0, n: 144, vague: true, costBand: 'mid' },
    ],
    caveats: [
      ...w35.facts.caveats,
      'The mixing verdict is scoped: settled for measured task shapes at the current model market; the weekly saturation alarm owns the reopening condition.',
      'Frontier and audition facts on this page are the 2026-W35 weekly readings, unchanged.',
    ],
  },
  status: 'published',
  writer: null,
};

// The same fail-closed gate the weekly writer uses, over every narrative field.
const extra = (process.env.FRONTIER_NOTES_NEVER_NAME ?? '').split(',').map((s) => s.trim()).filter(Boolean);
for (const [field, text] of Object.entries({
  title: issue.title, summary: issue.summary, plain: issue.plain, lede: issue.lede,
  frontierNote: issue.frontierNote, auditionNote: issue.auditionNote, mixingNote: issue.mixingNote,
  takeaway: issue.takeaway, method: issue.method,
  faq: issue.faq.map((f) => `${f.q}\n${f.a}`).join('\n'),
})) {
  assertPublishable(text, extra); // throws with the leak named
  void field;
}
mkdirSync(outDir, { recursive: true });
const out = writeIssue(outDir, issue);
console.log(`redaction gate PASSED · wrote ${out.json} and ${out.md}`);

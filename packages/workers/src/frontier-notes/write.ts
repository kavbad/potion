// Frontier Notes — the writer (docs/FRONTIER-NOTES.md).
//
// Two writers, same contract. The deterministic one renders the fact sheet
// into plain declarative prose and is always available; the model writer
// drafts the title, lede, three commentary notes and the FAQ answers from the
// fact sheet ONLY, and falls back to the deterministic text on any failure.
// Either way the output goes through redact.ts before it is an issue.

import type { Provider } from '@potion/providers';
import type { FactSheet, IssueFaq } from './types.js';

export interface Draft {
  title: string;
  summary: string;
  lede: string;
  frontierNote: string;
  auditionNote: string;
  mixingNote: string;
  faq: IssueFaq[];
}

export const METHOD_NOTE =
  'How these numbers are made. Every cluster of work (classification, extraction, code generation and the rest) has a retrieval-hostile suite of tasks the models have not seen. Each model, and each combination of models, is run on the full suite; code is scored by executing it, other answers by a rubric against a reference. Quality is the mean score with a bootstrap 95% interval, and two points whose intervals overlap are reported as tied. Cost is the measured cost per 1,000 requests at provider list prices. A frontier is the set of options nothing else beats on quality, cost and latency at once. Each week a small sample re-checks every frontier pick for drift, and new models on the public catalogue are measured on the work they look suited to.';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const q = (x: number) => x.toFixed(3);

/** Always available; plain; every number from the fact sheet. */
export function deterministicDraft(f: FactSheet): Draft {
  const held = f.frontier.filter((c) => c.verdict === 'ok');
  const moved = f.frontier.filter((c) => c.verdict === 'drift');
  const incon = f.frontier.filter((c) => c.verdict === 'inconclusive');
  const earned = f.auditions.filter((a) => a.outcome === 'earned a frontier slot');
  const mix = f.mixing[0];

  const titleParts: string[] = [];
  titleParts.push(
    moved.length === 0
      ? `All ${f.frontier.length} routing frontiers held this week`
      : `${moved.length} of ${f.frontier.length} routing frontiers moved this week`,
  );
  if (mix) {
    titleParts.push(
      mix.vague
        ? `a combination of models matched the best single on ${mix.family} work at a fraction of its cost`
        : `a combination matched the best single model on ${mix.clusterId} at ${pct(mix.costSaving)} less cost`,
    );
  } else if (earned.length > 0) {
    titleParts.push(`${earned[0]!.alias} earned a slot on ${earned[0]!.clusterId}`);
  }
  const title = titleParts.join('; ') + '.';

  const lede = [
    `Week ${f.week.split('-W')[1]} of ${f.week.split('-W')[0]}: ${f.numbers.canaries} drift canaries re-checked every routing frontier, ${f.numbers.candidatesScreened} new catalogue listings were screened and ${f.numbers.candidatesMeasured} were measured.`,
    moved.length === 0
      ? `No frontier moved${incon.length ? ` (${incon.length} check${incon.length > 1 ? 's' : ''} inconclusive)` : ''}.`
      : `${moved.map((m) => m.clusterId).join(', ')} moved and will be re-measured in full.`,
    mix
      ? mix.vague
        ? `The notable result is from the mixing lane: on ${mix.family} work, a combination of measured models matched the best single model's quality and came in ${mix.costBand}.`
        : `The notable result is from the mixing lane: on ${mix.clusterId}, a combination of measured models scored ${q(mix.meanQuality)} against the best single model, ${pct(mix.costSaving)} cheaper.`
      : 'Nothing in the mixing lane beat the best single model this week.',
  ].join(' ');

  const frontierNote =
    held.length === f.frontier.length
      ? `Every routed pick reproduced its stored quality inside its interval. ${f.frontier
          .filter((c) => c.observedMean !== null)
          .slice(0, 3)
          .map((c) => `${c.clusterId}: ${q(c.observedMean!)} observed against ${q(c.storedQuality)} ± ${q(c.storedCi95)} stored`)
          .join('; ')}.`
      : `${held.length} frontiers held, ${moved.length} moved${incon.length ? `, ${incon.length} inconclusive` : ''}. ${moved
          .map((c) => `${c.clusterId} fell to ${c.observedMean === null ? 'no reading' : q(c.observedMean)} against ${q(c.storedQuality)} ± ${q(c.storedCi95)}`)
          .join('; ')}.`;

  const auditionNote =
    f.auditions.length === 0
      ? 'No new model looked suited to a cluster this week, so none were measured.'
      : f.auditions
          .map((a) => `${a.alias} (${a.lane}) was measured on ${a.clusterId} and ${a.outcome}`)
          .join('; ') + '.';

  const mixingNote = mix
    ? mix.vague
      ? `A two-to-three-call combination of measured models, replayed over ${mix.n} ${mix.family} items, ${mix.kind === 'cheaper-and-as-good' ? 'matched the best single model and came in' : 'beat the best single model and came in'} ${mix.costBand}. The components and the rule that combines them are part of the routing product and are not published.`
      : `On ${mix.clusterId}, a combination of measured models replayed over ${mix.n} items scored ${q(mix.meanQuality)} (${mix.qualityDeltaVsBestSingle >= 0 ? '+' : ''}${q(mix.qualityDeltaVsBestSingle)} against the best single) at ${pct(mix.costSaving)} lower cost. The components and the rule are not published.`
    : 'The mixing lane replays combinations of measured models over stored item-level results; nothing this week was both cheaper and as good as the best single model.';

  const cheapest = f.frontier.filter((c) => c.pick !== 'name withheld' && c.verdict === 'ok');
  const faq: IssueFaq[] = [
    {
      q: 'What is a routing frontier?',
      a: 'The set of model options for one kind of work that nothing else beats on quality, cost and latency at the same time. A routing policy picks from it: cheapest above a quality floor, fastest, or best quality.',
    },
    {
      q: `Did any model's quality change this week?`,
      a:
        moved.length === 0
          ? `No. All ${f.frontier.length} frontier picks reproduced their stored quality inside the 95% interval on a ${f.frontier[0]?.n ?? 4}-item canary.`
          : `Yes: ${moved.map((m) => m.clusterId).join(', ')}. Those frontiers are re-measured in full before routing changes.`,
    },
    {
      q: 'Which measured model held its frontier pick this week?',
      a: cheapest.length
        ? `${cheapest
            .slice(0, 3)
            .map((c) => `${c.pick} on ${c.clusterId} (${q(c.storedQuality)} ± ${q(c.storedCi95)})`)
            .join('; ')}. Some picks are withheld by name; their numbers are published.`
        : 'The picks with published names are listed in the frontier table; some picks are withheld by name.',
    },
  ];

  const summary = `${lede.split('. ').slice(0, 2).join('. ')}.`.replace(/\.\.$/, '.');
  return { title, summary, lede, frontierNote, auditionNote, mixingNote, faq };
}

const SYSTEM = `You write Frontier Notes, a weekly research note on measured AI model routing. You are given a FACT SHEET as JSON. Write ONLY from it. Rules that cannot be broken:
- Never name a model that the fact sheet calls "name withheld"; never guess or describe which model it might be.
- Never describe how models are combined: no mechanism names, no component names, no thresholds, no order of calls. Say "a combination of measured models".
- Where a mixing fact has vague=true it carries no clusterId: say "<family> work" (for example "code work", "structured output work") and use the costBand words, never an exact ratio and never a specific kind of work.
- Use every number exactly as given. Always give intervals with quality figures. No superlatives the numbers do not support. No marketing. British understatement.
- Plain declarative sentences. No em dashes. No headings. No bullet lists.
Return strict JSON: {"title": string (a finding, under 120 chars, ends with a full stop), "summary": string (one paragraph, under 300 chars), "lede": string (3 sentences), "frontierNote": string (2-4 sentences), "auditionNote": string (1-3 sentences), "mixingNote": string (2-3 sentences), "faq": [{"q": string, "a": string}] (exactly 3 evergreen questions a buyer would type into a search engine, answered from this week's numbers)}`;

export interface ModelWriterOptions {
  provider: Provider;
  model: string;
  /** Cost attribution; the provider's own billed cost is preferred when reported. */
  costPer1KTokens?: { input: number; output: number };
}

/** Drafts with a model; on any failure returns the deterministic draft and a note. */
export async function modelDraft(f: FactSheet, opts: ModelWriterOptions): Promise<{ draft: Draft; costUsd: number; fallback: string | null }> {
  const fallback = deterministicDraft(f);
  try {
    const res = await opts.provider.complete({
      model: opts.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `FACT SHEET:\n${JSON.stringify(f, null, 1)}\n\nA deterministic draft for reference (improve its prose; do not add facts):\n${JSON.stringify(fallback, null, 1)}` },
      ],
      params: { temperature: 0.3, maxTokens: 1800 },
    });
    const costUsd =
      res.usage.providerCostUsd ??
      (opts.costPer1KTokens
        ? (res.usage.inputTokens * opts.costPer1KTokens.input + res.usage.outputTokens * opts.costPer1KTokens.output) / 1000
        : 0);
    const parsed = parseDraft(res.text);
    if (!parsed) return { draft: fallback, costUsd, fallback: 'writer returned no parseable draft' };
    return { draft: parsed, costUsd, fallback: null };
  } catch (e) {
    return { draft: fallback, costUsd: 0, fallback: e instanceof Error ? e.message : String(e) };
  }
}

export function parseDraft(text: string): Draft | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Draft>;
    const s = (k: keyof Draft) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
    const title = s('title'), summary = s('summary'), lede = s('lede'), frontierNote = s('frontierNote'), auditionNote = s('auditionNote'), mixingNote = s('mixingNote');
    if (!title || !summary || !lede || !frontierNote || !auditionNote || !mixingNote) return null;
    const faq = Array.isArray(o.faq)
      ? o.faq.filter((x): x is IssueFaq => !!x && typeof x.q === 'string' && typeof x.a === 'string').slice(0, 3)
      : [];
    if (faq.length !== 3) return null;
    return { title, summary, lede, frontierNote, auditionNote, mixingNote, faq };
  } catch {
    return null;
  }
}

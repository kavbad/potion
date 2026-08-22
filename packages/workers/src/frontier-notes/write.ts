// Frontier Notes — the writer (docs/FRONTIER-NOTES.md).
//
// Two writers, same contract. The deterministic one renders the fact sheet
// into plain declarative prose and is always available; the model writer
// drafts the title, lede, three commentary notes and the FAQ answers from the
// fact sheet ONLY, and falls back to the deterministic text on any failure.
// Either way the output goes through redact.ts before it is an issue.

import type { Provider } from '@potion/providers';
import type { FactSheet, IssueFaq, WriterReceipt } from './types.js';

export interface Draft {
  title: string;
  summary: string;
  /** Three to five short plain-English sentences for a reader who knows nothing about AI models. */
  plain: string;
  lede: string;
  frontierNote: string;
  auditionNote: string;
  mixingNote: string;
  /** Why a buyer should care: two or three sentences, plain words, no numbers needed. */
  takeaway: string;
  faq: IssueFaq[];
}

export const METHOD_NOTE =
  'How these numbers are made, in plain words. We sort requests into kinds of work: sorting text into categories, pulling fields out of documents, writing code, answering from a set of documents, and so on. For each kind we keep a private exam of tasks the models have never seen. Every model sits the same exam. Code is marked by running it; other answers are marked against a reference answer. A model\'s quality is its average mark, and because an exam is a sample we also give a margin of error: two models whose margins overlap are called a tie. Cost is what a thousand requests would cost at the provider\'s public prices. A frontier is the short list of models that are the best deal at their level of quality, meaning nothing else is both better and cheaper. Each week we re-check every model on that list with a few fresh tasks to catch any that have got worse, and we give newly released models the exam for the work they look suited to.';

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

  const plain = [
    'Potion keeps a scoreboard of AI models: how well each one does a kind of work, and what it costs.',
    moved.length === 0
      ? 'This week every model on the scoreboard was re-checked and none had got worse.'
      : `This week ${moved.length} model${moved.length > 1 ? 's' : ''} on the scoreboard did worse than before and will be re-tested in full.`,
    f.auditions.length
      ? `${f.auditions.length} newly released model${f.auditions.length > 1 ? 's were' : ' was'} tested; ${earned.length ? `${earned.length} made the scoreboard` : 'none did better than the models already on it'}.`
      : 'No newly released model looked worth testing this week.',
    mix
      ? `The interesting result: for ${mix.vague ? `${mix.family} work` : mix.clusterId}, using two or three cheap models together in a particular way gave answers as good as the best single model for ${mix.vague ? mix.costBand.replace(/cheaper$/, 'less') : `${pct(mix.costSaving)} less`}.`
      : 'No combination of cheaper models beat the best single model this week.',
  ].join(' ');
  const takeaway = mix
    ? 'If you pay for AI by the request, the gap between the best model and the cheapest model that is good enough is where your money goes. This week that gap was measured again, and it is still wide. Routing each request to the cheapest model that passed the exam is how you keep the quality and stop paying for the rest.'
    : 'If you pay for AI by the request, the gap between the best model and the cheapest model that is good enough is where your money goes. Routing each request to the cheapest model that passed the exam is how you keep the quality and stop paying for the rest.';
  const summary = plain.split('. ').slice(0, 2).join('. ') + '.';
  return { title, summary, plain, lede, frontierNote, auditionNote, mixingNote, takeaway, faq };
}

const SYSTEM = `You write Frontier Notes, a weekly research note about which AI models are the best value for different kinds of work. Your reader is a smart person who runs a business and has never read a machine-learning paper. Write so that they enjoy it and understand every sentence. You are given a FACT SHEET as JSON. Write ONLY from it.

Rules that cannot be broken:
- Never name a model that the fact sheet calls "name withheld"; never guess or describe which model it might be.
- Never describe how models are combined: no mechanism names, no component names, no thresholds, no order of calls. Say "a combination of measured models" or "two or three cheaper models used together in a particular way".
- Where a mixing fact has vague=true it carries no clusterId: say "<family> work" (for example "code work", "structured output work") and use the costBand words, never an exact ratio and never a specific kind of work.
- Use every number exactly as given. Give the margin of error with every quality figure, written as "0.979, give or take 0.020".

Rules of the house style:
- The first time you use any technical term, explain it in the same sentence in plain words. Terms that always need this: cluster (a kind of work), frontier (the short list of best-value models), canary (a small weekly re-check), interval or margin (how sure we are), cost per 1,000 requests (what a thousand requests would cost), quality (the exam score), audition (a first exam for a newly released model), replay (re-scoring a combination from results we already have, without spending money).
- Short sentences. Concrete nouns. One idea per sentence. No jargon for its own sake. No em dashes. No headings. No bullet lists. No superlatives the numbers do not support. No marketing.
- Explain why a reader should care, not just what happened.

Return strict JSON: {"title": string (a finding in plain words, under 110 chars, ends with a full stop), "summary": string (one paragraph under 280 chars, plain words), "plain": string (3 to 5 short sentences a non-technical reader fully understands: what was checked, what was found, why it matters), "lede": string (3 sentences with the key numbers, each term explained), "frontierNote": string (2 to 4 sentences about the re-checks, explaining canary and margin of error on first use), "auditionNote": string (1 to 3 sentences about the newly released models tested), "mixingNote": string (2 to 3 sentences on the combination findings, explaining replay on first use), "takeaway": string (2 or 3 sentences on what this means for someone paying for AI by the request), "faq": [{"q": string, "a": string}] (exactly 3 questions a buyer would type into a search engine, answered in plain words from this week's numbers)}`;

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
      params: { temperature: 0.3, maxTokens: 4000 },
    });
    const costUsd =
      res.usage.providerCostUsd ??
      (opts.costPer1KTokens
        ? (res.usage.inputTokens * opts.costPer1KTokens.input + res.usage.outputTokens * opts.costPer1KTokens.output) / 1000
        : 0);
    const parsed = parseDraft(res.text, fallback);
    if (!parsed) return { draft: fallback, costUsd, fallback: 'writer returned no parseable draft' };
    return { draft: parsed, costUsd, fallback: null };
  } catch (e) {
    return { draft: fallback, costUsd: 0, fallback: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Parse a model's draft. With a `reference` draft, small shape drift is
 * tolerated — a missing secondary field or a FAQ list of 2 or 4 — and filled
 * from the reference; the title and the plain-words opening must be the
 * model's own. Without a reference the shape must be exact.
 */
export function parseDraft(text: string, reference?: Draft): Draft | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Draft>;
    const s = (k: keyof Draft) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
    const title = s('title'), plain = s('plain');
    if (!title || !plain) return null;
    const pick = (k: Exclude<keyof Draft, 'faq'>) => s(k) ?? reference?.[k] ?? null;
    const summary = pick('summary'), lede = pick('lede'), frontierNote = pick('frontierNote'), auditionNote = pick('auditionNote'), mixingNote = pick('mixingNote'), takeaway = pick('takeaway');
    if (!summary || !lede || !frontierNote || !auditionNote || !mixingNote || !takeaway) return null;
    let faq = Array.isArray(o.faq)
      ? o.faq.filter((x): x is IssueFaq => !!x && typeof x.q === 'string' && typeof x.a === 'string' && x.q.trim() !== '' && x.a.trim() !== '')
      : [];
    if (reference && faq.length > 0 && faq.length < 3) faq = [...faq, ...reference.faq.filter((r) => !faq.some((x) => x.q === r.q))];
    faq = faq.slice(0, 3);
    if (faq.length !== 3) return null;
    return { title, summary, plain, lede, frontierNote, auditionNote, mixingNote, takeaway, faq };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The dogfood writer: Frontier Notes is written THROUGH Potion's own serving
// API, as a customer would call it — one OpenAI-shaped request under the
// org's bound policy. The receipt that comes back (x-frontier-trace) is
// printed in the issue. If Potion is unreachable the caller falls back to
// the deterministic draft; the issue still publishes, and says so.
export interface PotionWriterOptions {
  /** e.g. http://server:3000 inside compose, https://api.withpotion.com outside. */
  url: string;
  apiKey: string;
  /** The model label; 'potion-auto' lets the policy choose. */
  model?: string;
  /** Per-request policy override by name (x-potion-policy): the writer asks for quality on this one call. */
  policy?: string;
  /** Tell Potion the kind of work (x-potion-cluster). A JSON-heavy prompt reads as
   * 'classification' to the classifier; this is a writing job. */
  cluster?: string;
  fetchImpl?: typeof fetch;
}

export function parseTrace(h: string | null): Omit<WriterReceipt, 'promptTokens' | 'completionTokens'> {
  const kv: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) kv[k.trim()] = v.trim();
  }
  return { cluster: kv.cluster ?? 'unknown', strategy8: kv.strategy ?? '', policy: kv.policy ?? '', provenance: kv.provenance ?? '' };
}

export async function potionDraft(
  f: FactSheet,
  o: PotionWriterOptions,
): Promise<{ draft: Draft; receipt: WriterReceipt | null; fallback: string | null }> {
  const fallback = deterministicDraft(f);
  const fetchImpl = o.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${o.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}`, ...(o.policy ? { 'x-potion-policy': o.policy } : {}), ...(o.cluster ? { 'x-potion-cluster': o.cluster } : {}) },
      body: JSON.stringify({
        model: o.model ?? 'potion-auto',
        temperature: 0.3,
        // A verbose model needs room for the whole JSON draft; this bound is
        // honored since 2026-08-22 (it was ignored before, which hid the cut).
        max_tokens: 4000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `FACT SHEET:\n${JSON.stringify(f, null, 1)}\n\nA deterministic draft for reference (improve its prose; do not add facts):\n${JSON.stringify(fallback, null, 1)}` },
        ],
      }),
    });
    if (!res.ok) return { draft: fallback, receipt: null, fallback: `potion HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = body.choices?.[0]?.message?.content ?? '';
    const receipt: WriterReceipt = {
      ...parseTrace(res.headers.get('x-frontier-trace')),
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    };
    const parsed = parseDraft(text, fallback);
    if (!parsed) return { draft: fallback, receipt, fallback: `potion returned no parseable draft (${text.length} chars, finish ${String((body as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason)})` };
    return { draft: parsed, receipt, fallback: null };
  } catch (e) {
    return { draft: fallback, receipt: null, fallback: e instanceof Error ? e.message : String(e) };
  }
}

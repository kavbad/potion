// Frontier Notes — the deterministic style lint (docs/RESEARCH-WRITING.md
// E4: style enforcement is deterministic where it can be). The banned
// generic-AI-content signatures (§5) and inflated vocabulary (§3) block a
// model-written draft before it costs an Auditor run; the judge handles
// what lints cannot. A slop-phrase regex costs nothing and never has an
// off day.
import type { Draft } from './write.js';
import type { MixingFact } from './types.js';

const BANNED_PHRASES = [
  'rapidly evolving',
  'continues to transform',
  'has never been more important',
  'one-size-fits-all',
  'in this article',
  "let's dive in",
  'dive in',
  'may surprise you',
  'highlights the importance',
  'the future of ai',
] as const;

const INFLATED_VOCAB = [
  'revolutionary',
  'transformative',
  'paradigm',
  'game-changing',
  'game changing',
  'groundbreaking',
  'unprecedented',
] as const;

/** Returns the first style violation, or null. */
export function lintDraft(draft: Draft): string | null {
  const raw = [draft.title, draft.summary, draft.plain, draft.lede, draft.frontierNote, draft.auditionNote, draft.mixingNote, draft.takeaway, ...draft.faq.flatMap((f) => [f.q, f.a])].join(' ');
  const ownSpend = auditNoOwnSpend(raw);
  if (ownSpend !== null) return ownSpend;
  const text = raw.toLowerCase();
  for (const p of BANNED_PHRASES) {
    if (text.includes(p)) return `banned phrase: "${p}"`;
  }
  for (const w of INFLATED_VOCAB) {
    if (text.includes(w)) return `inflated vocabulary: "${w}"`;
  }
  return null;
}

/** THE SAY-IT-ONCE LAW (operator, 2026-09-05: "fix delta's repetitive
 * prose").
 *
 * The first published daily said the same four numbers three times. That
 * was OUR fault, not the writer's: the assignment asked `plain` for "what
 * was compared, what the gap is" and then asked `lede` for "the key numbers
 * with their sample size" — the same paragraph, ordered twice. The fields
 * now have distinct jobs (finding / meaning / decision), and this law keeps
 * them distinct when a future assignment drifts back.
 *
 * A later paragraph may REFER to a figure — "the extra 8.7 points" earns
 * its place in an argument. It may not RESTATE the finding: if every figure
 * it carries was already stated and it carries several, it is paragraph one
 * again in different words. Referring back is cheap, so the bar is the full
 * set, not any overlap.
 *
 * Deliberately scoped to the daily piece. The weekly issue's plain and lede
 * sit under one heading with different jobs of their own and have not shown
 * this failure; widening the law there is a separate change with its own
 * evidence. */
const RESTATEMENT_FLOOR = 3;

/** Figures a paragraph states, with identifiers (`gpt-5.6-terra-pro`) removed
 * first — a version number is not a claim. Mirrors THE PIECE NUMBER LAW. */
function figuresIn(text: string): Set<string> {
  const bare = text.replace(/[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*[.-]v?\d+(?:\.\d+)*[A-Za-z]*/g, ' ');
  const out = new Set<string>();
  for (const m of bare.matchAll(/(?<![\w.])(\d+(?:[.,]\d+)?)(?![\w])/g)) out.add(m[1]!.replace(/,/g, ''));
  return out;
}

/** Normalized sentences, for the verbatim-echo check. */
function sentencesIn(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.split(' ').length >= 6);
}

/** Returns the repetition violation, or null. */
export function auditRepetition(draft: Pick<Draft, 'plain' | 'lede' | 'takeaway'>): string | null {
  // The rule applies to BOTH later paragraphs. It was scoped to the lede at
  // first, on the reasoning that a recommendation legitimately names its
  // options and their prices — and the very next piece (run-564edfaf) used
  // that permission to re-run the entire comparison, both prices and the
  // ratio, in a paragraph whose job was to say what to DO. Naming one or two
  // figures to make the decision concrete still passes; restating the
  // finding does not, whichever paragraph does it.
  const plain = figuresIn(draft.plain);
  const jobs: [string, Set<string>, string][] = [
    ['second', figuresIn(draft.lede), 'It should say what the gap MEANS, not say it again'],
    ['third', figuresIn(draft.takeaway), 'It should say what to DO about the gap, not state it again'],
  ];
  for (const [which, figures, job] of jobs) {
    if (figures.size >= RESTATEMENT_FLOOR && [...figures].every((f) => plain.has(f))) {
      return `the ${which} paragraph restates the finding — it states ${figures.size} figures and every one of them is already in the first. ${job}`;
    }
  }
  // A sentence repeated across paragraphs is wrong in any piece, anywhere.
  const seen = new Map<string, number>();
  for (const [i, para] of [draft.plain, draft.lede, draft.takeaway].entries()) {
    for (const s of sentencesIn(para)) {
      const first = seen.get(s);
      if (first !== undefined && first !== i) return `the same sentence appears in two paragraphs: "${s.slice(0, 60)}…"`;
      seen.set(s, i);
    }
  }
  return null;
}

/** THE OWN-SPEND LAW (operator, 2026-09-04: "our pieces should never write
 * how much we spend").
 *
 * The distinction that matters: what a MODEL costs a reader is the entire
 * product and must be stated precisely; what POTION spent running its own
 * instruments is operational trivia that makes the research look like a
 * hobby budget and tells a competitor our cost base. The first is the
 * story, the second never appears.
 *
 * Enforced in three places rather than trusted to a prompt: the figure is
 * stripped from the fact sheets writers receive, removed from every
 * composed line, and refused here if prose reaches for it anyway. */
const OWN_SPEND_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bwe spent\b/i, what: '"we spent"' },
  { re: /\bour (own )?(spend|budget|costs?)\b/i, what: '"our spend"' },
  { re: /\bcost (us|potion)\b/i, what: '"cost us"' },
  { re: /\bthe (week|day|run|sweep|check|measurement|cycle)s?\b[^.]{0,40}\bcost\b[^.]{0,20}\$/i, what: 'the cost of running the measurement' },
  { re: /\b(measurement|research|instrument|canary|audition)s?\b[^.]{0,30}\b(spend|spent|budget)\b/i, what: 'the measurement budget' },
  { re: /\bspend(ing)?\b[^.]{0,20}\b(was|of|totall?ed|came to)\b[^.]{0,10}\$/i, what: 'a spend total' },
  { re: /\$[\d.]+\s*(to run|for the (week|day|run|check|sweep))/i, what: 'the price of running our own week' },
  // The provenance footer published "$0.0031 metered" — our own writer bill,
  // on the page, under every piece (found live 2026-09-04). A figure the
  // prose never wrote still reached the reader through the template, so the
  // law now runs over the rendered page and not only over the draft.
  { re: /\$[\d.]+\s*metered/i, what: "the writer run's metered cost" },
];

/** Returns the violation, or null. Model prices per request are untouched. */
export function auditNoOwnSpend(text: string): string | null {
  for (const p of OWN_SPEND_PATTERNS) {
    if (p.re.test(text)) return `the piece states ${p.what} — Potion's own operating spend is never published`;
  }
  return null;
}

/**
 * A WIN LABEL MUST NAME A WIN (2026-09-05).
 *
 * MixingFact.kind is the VERDICT and `shape` is the description, a split
 * made because a close note reports measured losses and the union could
 * previously only say 'cheaper-and-as-good' or 'frontier-candidate'. Rows
 * with costSaving -0.12 were being written under a winning label with the
 * strategy's shape in the verdict field.
 *
 * The type now permits the honest answer; this makes the dishonest one
 * impossible to publish. Deterministic and cheap, in the layer that already
 * refuses inflated vocabulary — because the same instinct that reaches for
 * "groundbreaking" is the one that files a loss as a candidate.
 *
 * It is deliberately one-directional: a 'no-win' with a positive saving is
 * ALSO refused. Understating a real win is not a safe error — it is the
 * same lie pointed the other way, and it would quietly bury the results
 * this loop exists to find.
 */
export function auditMixingVerdicts(facts: readonly MixingFact[]): string | null {
  for (const f of facts) {
    const where = f.clusterId ?? f.family;
    const win = f.kind === 'cheaper-and-as-good' || f.kind === 'frontier-candidate';
    if (win && f.costSaving <= 0) {
      return `mixing fact on ${where} is labelled '${f.kind}' but saved nothing (costSaving ${f.costSaving}) — a mixture that did not win is 'no-win'`;
    }
    if (win && f.qualityDeltaVsBestSingle < 0) {
      return `mixing fact on ${where} is labelled '${f.kind}' but scored below the best single (quality delta ${f.qualityDeltaVsBestSingle}) — that is not a win`;
    }
    if (f.kind === 'no-win' && f.costSaving > 0 && f.qualityDeltaVsBestSingle >= 0) {
      return `mixing fact on ${where} is labelled 'no-win' but beat the best single on both axes (costSaving ${f.costSaving}, quality delta ${f.qualityDeltaVsBestSingle}) — understating a win buries it`;
    }
  }
  return null;
}

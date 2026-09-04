// Frontier Notes — the deterministic style lint (docs/RESEARCH-WRITING.md
// E4: style enforcement is deterministic where it can be). The banned
// generic-AI-content signatures (§5) and inflated vocabulary (§3) block a
// model-written draft before it costs an Auditor run; the judge handles
// what lints cannot. A slop-phrase regex costs nothing and never has an
// off day.
import type { Draft } from './write.js';

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
];

/** Returns the violation, or null. Model prices per request are untouched. */
export function auditNoOwnSpend(text: string): string | null {
  for (const p of OWN_SPEND_PATTERNS) {
    if (p.re.test(text)) return `the piece states ${p.what} — Potion's own operating spend is never published`;
  }
  return null;
}

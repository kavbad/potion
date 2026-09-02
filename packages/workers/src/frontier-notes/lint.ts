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
  const text = [draft.title, draft.summary, draft.plain, draft.lede, draft.frontierNote, draft.auditionNote, draft.mixingNote, draft.takeaway, ...draft.faq.flatMap((f) => [f.q, f.a])]
    .join(' ')
    .toLowerCase();
  for (const p of BANNED_PHRASES) {
    if (text.includes(p)) return `banned phrase: "${p}"`;
  }
  for (const w of INFLATED_VOCAB) {
    if (text.includes(w)) return `inflated vocabulary: "${w}"`;
  }
  return null;
}

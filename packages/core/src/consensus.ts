/**
 * How two answers are compared when a mechanism asks whether they AGREE —
 * the program interpreter's `vote` and `agree` operators, and anything else
 * that has to decide "same answer, or not".
 *
 * Comparing WHOLE replies makes agreement a question of prose style. Models
 * told to "solve step by step" essentially never write identical text, so
 * every vote bucket holds one ballot and the majority rule can never fire:
 * measured live on GSM8K (2026-09-07), a three-model vote degenerated to its
 * first branch while paying for all three calls, and scored 2.3 points BELOW
 * that branch run alone.
 *
 * So: when a reply DECLARES a final answer, agreement is judged on that.
 * Otherwise it is judged on the whole normalized text — which is what a bare
 * one-line answer already is, and what a code or prose deliverable needs.
 * A reply that declares nothing therefore behaves exactly as it did before.
 */

const TRAILING_PUNCT = /[.!?,;:]+$/;

/** Case, whitespace and trailing punctuation are not part of an answer. */
export function normalizeAnswer(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(TRAILING_PUNCT, '');
}

/**
 * The value of a bare number, else null. Reads through currency, thousands
 * separators and spaces, so "$1,234" and "1234" are the same answer. Anything
 * carrying other text is NOT a number — "12 apples" compares as text.
 */
export function numericAnswer(text: string): number | null {
  const bare = text.replace(/[$\s]/g, '').replace(/,(?=\d{3}(?!\d))/g, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(bare)) return null;
  const n = Number(bare);
  return Number.isFinite(n) ? n : null;
}

/**
 * The key two answers must share to count as the same answer. The last
 * "Final answer: …" the reply declares wins (a model may restate it); an
 * empty or absent declaration falls back to the whole text.
 */
export function consensusKey(text: string): string {
  const labelled = [...text.matchAll(/final\s+answer\s*[:=]?\s*(.+?)\s*$/gim)];
  const raw = (labelled[labelled.length - 1]?.[1] ?? '')
    .replace(/[*`_]/g, '')
    .trim()
    .replace(TRAILING_PUNCT, '');
  if (raw === '') return `t:${normalizeAnswer(text)}`;
  const n = numericAnswer(raw);
  return n !== null ? `n:${n}` : `t:${normalizeAnswer(raw)}`;
}

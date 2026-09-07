// CONTEXT SELECTION (C4 rung 3, docs/INFERENCE-COMPILER-PLAN.md).
//
// WHAT THIS IS NOT. The review asks for "retrieval strategy" and gives
// `retrieve → A → verify → B` as an example program. A `retrieve` op fetches
// from a corpus, and Potion does not have one: the customer's documents live
// in the customer's store, and ingesting them to optimize retrieval would be a
// data-residency decision, not a compiler rung. Building a `retrieve` op that
// cannot run on real traffic would be a mechanism that measures nothing.
//
// WHAT POTION CAN OWN. A RAG request arrives with its context ALREADY IN THE
// PROMPT — that is what the `rag-answer` cluster is. Nothing needs fetching;
// the question is how much of it to send. And that is where the money is:
// input tokens dominate a grounded-answer bill, and most of a pasted context
// blob is irrelevant to the specific question asked.
//
// So the instruction is SELECT, not RETRIEVE, and the difference is stated
// rather than papered over. True retrieval needs either a customer corpus or
// the retriever-as-tool callback of C4b.
//
// WHY IT IS A CALL PARAMETER AND NOT A NODE. A `select` NODE would have to
// rebind `messages` for its subtree — and the interpreter's memo keys on node
// structure alone, on the invariant that `messages` is constant through the
// tree. Two identical `call(m)` nodes under two different selections would
// collapse to one call with the wrong context. Putting selection on the call
// keeps the invariant and makes selection part of the node's identity, exactly
// like reasoning effort and prompt variant.
import type { ChatMessage } from './types.js';

/** Keep the top-k paragraphs of the largest message. */
export interface ContextSelect {
  keepParagraphs: number;
}

/** Paragraph boundary: a blank line — how pasted context is actually shaped. */
const PARAGRAPH = /\n\s*\n/;

/**
 * Content words, for overlap scoring. Deliberately lexical: no embedder, no
 * extra provider round trip, no cost the preflight cannot see. A heuristic
 * that is free and honest beats one that is better and unpriced.
 *
 * Two normalizations, both learned from a test that caught the naive version
 * being worse than useless. Without them, "How long is the refund window?"
 * matched a paragraph about WARRANTIES better than the one about refunds:
 *   · stopwords — 'the' appears in every paragraph, so an unfiltered overlap
 *     ranks by how many common words a chunk happens to contain;
 *   · a plural strip — 'refund' in the question never met 'refunds' in the
 *     answer, so the one paragraph that mattered scored ZERO.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of',
  'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'with',
  'do', 'does', 'did', 'can', 'will', 'would', 'long', 'much', 'many', 'my', 'our', 'your',
]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
}

function overlap(chunk: string, query: Set<string>): number {
  const w = words(chunk);
  let n = 0;
  for (const t of w) if (query.has(t)) n++;
  // Normalize by chunk size so a long irrelevant paragraph cannot out-score a
  // short exact one purely by having more words.
  return w.size === 0 ? 0 : n / Math.sqrt(w.size);
}

/**
 * Keep the k paragraphs of the LARGEST message that best overlap the last user
 * turn; every other message is untouched, and the paragraphs keep their
 * original order so the context still reads as a document.
 *
 * No-ops (returns the input array itself) when there is nothing to do: no
 * selection, fewer paragraphs than k, or a request with no question to rank
 * against. A selector that silently drops the whole context would be worse
 * than no selector.
 */
export function selectContext(
  messages: ChatMessage[],
  select: ContextSelect | undefined,
): ChatMessage[] {
  if (select === undefined || select.keepParagraphs < 1) return messages;
  let biggest = -1;
  for (let i = 0; i < messages.length; i++) {
    if (biggest === -1 || messages[i]!.content.length > messages[biggest]!.content.length) biggest = i;
  }
  if (biggest === -1) return messages;
  const chunks = messages[biggest]!.content.split(PARAGRAPH);
  if (chunks.length <= select.keepParagraphs) return messages;

  // Rank against the last USER turn — the question — excluding the blob itself.
  const question = [...messages].reverse().find((m, idx) => m.role === 'user' && messages.length - 1 - idx !== biggest);
  if (question === undefined) return messages;
  const q = words(question.content);
  const kept = chunks
    .map((text, index) => ({ text, index, score: overlap(text, q) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, select.keepParagraphs)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.text);

  const out = [...messages];
  out[biggest] = { ...messages[biggest]!, content: kept.join('\n\n') };
  return out;
}

/** Prompt size below which selection cannot pay for itself — there is nothing
 *  to drop. Derived conditioning uses this; see WorkloadFeatures. */
export const SELECT_MIN_PROMPT_CHARS = 2000;

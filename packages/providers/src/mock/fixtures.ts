// Mock fixture data (SPEC §2): generation word bank + the keyword→cluster
// contract shared with packages/cluster (SPEC §4). Deterministic, no network.
//
// M1a quarantine: the eval task corpus (tasks + references + corruption
// engine) moved to ./eval-corpus.ts — TEST/CI SIMULATION ONLY, never
// authoritative for customer-facing evals. This file keeps only the
// production-path fixtures (word bank, cluster keywords, strategy-format
// markers); specialFixtureText delegates EVAL prompts to ./eval-corpus.ts.
import {
  SCORE_MARKER,
  evalAnswerFixtureText,
  evalJudgePickText,
  evalJudgeScoreText,
  evalSelfReportText,
} from './eval-corpus.js';

/** Vocabulary for deterministic mock text generation. */
export const MOCK_WORDS: string[] = [
  'the', 'a', 'result', 'answer', 'output', 'value', 'input', 'given', 'therefore',
  'first', 'then', 'finally', 'because', 'however', 'note', 'consider', 'assume',
  'step', 'check', 'compute', 'return', 'valid', 'edge', 'case', 'example',
  'data', 'item', 'list', 'field', 'record', 'table', 'query', 'response',
  'correct', 'complete', 'concise', 'clear', 'robust', 'simple', 'direct',
  'analysis', 'summary', 'detail', 'context', 'reason', 'approach', 'method',
];

/**
 * Keyword → seeded-cluster inference for the mock embedder (SPEC §4 contract:
 * "function/python/bug"→code-gen, "extract/json"→extraction,
 * "summarize/tl;dr"→summarization…). packages/cluster relies on this mapping
 * so mock embeddings of exemplar-like texts land near their cluster centroid.
 * First matching group wins (order matters).
 *
 * Group order: code-review is checked BEFORE code-gen because real review
 * prompts almost always contain code vocabulary ("Review this Python
 * function…", "…diff … bugs…") while code-gen prompts rarely say "review";
 * the reverse order mis-seeds most of the code-review cluster. All other
 * groups keep their original relative order.
 *
 * Phase 2 (ADDITIVE): keyword lists were extended for the real 10-cluster
 * taxonomy + held-out data (Gate 2). Matching is plain substring on the
 * lowercased text, so additions deliberately avoid landmines like 'rust'
 * (⊂ "frustrated"), 'tag' (⊂ "staging") — those remain from the original
 * SPEC lists and are kept for back-compat. Vector math, dims, noise bound,
 * and determinism are unchanged.
 */
export const CLUSTER_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // code-review: diffs, PRs, review requests. Checked first (see note above);
  // 'look over'/'take a look'/'critique' catch review phrasing without code words.
  ['code-review', ['review', 'diff', 'pull request', 'pr feedback', 'lint', 'refactor', 'look over', 'take a look', 'critique']],
  // code-gen: SPEC originals + concrete stack/task words (sql, bash, react, …).
  // Multi-word 'react hook'/'react component'/'rust struct' avoid stealing
  // extraction changelogs ("Upgraded react to…") or "frustrated" ('rust' ⊂).
  ['code-gen', ['function', 'python', 'bug', 'javascript', 'typescript', 'code', 'implement', 'compile', 'algorithm', 'sql', 'bash', 'react hook', 'react component', 'node.js', 'express', 'graphql', 'mongoose', 'one-liner', 'camelcase', 'rust struct']],
  // extraction: SPEC originals only — coverage is already near-perfect.
  ['extraction', ['extract', 'json', 'parse', 'field', 'entity', 'scrape']],
  // summarization: 'digest'/'recap' are common summarize-without-"summary" phrasings.
  ['summarization', ['summarize', 'tl;dr', 'summary', 'condense', 'brief', 'digest', 'recap']],
  // classification: label/score/triage verbs that don't appear in earlier clusters' prompts.
  ['classification', ['classify', 'label', 'category', 'sentiment', 'tag', 'spam', 'categorize', 'toxicity', 'subjective', 'topic bucket', 'rate this', 'churn', 'sarcastic', 'refund']],
  // multi-step-reasoning: word-problem/logic-puzzle markers. Generic 'how many'/
  // 'how long'/'recipe'/'meetings' were rejected — they steal rag/agentic prompts.
  ['multi-step-reasoning', ['step by step', 'reason', 'math', 'prove', 'logic', 'puzzle', 'how much', 'probability', 'original price', 'older than', 'taller than', 'shorter than', 'youngest', 'shortest', 'show your work', 'show the', 'perimeter', 'rectangle', 'rectangular', 'balance scale', 'liters', 'packs of', 'apr', 'loan', 'divisible', 'remainder', 'tiling', 'bloops', 'dice', 'yesterday', 'investment', 'arrange', 'buy 2 get', 'mpg', 'stairs', 'switches', 'constraints', 'clock', 'weighings', 'marbles', 'jug', 'trailing zeros', 'painters', 'horses', 'passwords', 'pump', 'pipes', 'flour', 'what time do they', 'vegetarian', 'lodging', 'overlap', 'travel between', 'by what percent', 'runners']],
  // creative: genres/forms + "invent a scene" phrasing. 'invent a'/'invent three'
  // (not bare 'invent') avoid stealing "inventory" ops prompts.
  ['creative', ['story', 'poem', 'imagine', 'fiction', 'creative', 'song', 'haiku', 'slogan', 'dialogue', 'villain', 'character sketch', 'novel', 'shanty', 'monologue', 'mythology', 'myth', 'backstories', 'parody', 'lullaby', 'sonnet', 'superhero', 'fantasy', 'opening scene', 'opening paragraph', 'limerick', 'comic book', 'fortune', 'festival', 'describe a', 'letter of complaint', 'breakup letter', 'invent a', 'invent three', 'scene where']],
  // rewrite-edit: transform verbs applied to a quoted text ("make this … kinder").
  ['rewrite-edit', ['rewrite', 'edit', 'rephrase', 'paraphrase', 'tone', 'grammar', 'make this', 'shorten', 'reword', 'simplify', 'expand this', 'convert this', 'adjust this', 'translate the', 'dangling modifier', 'comma splice', 'plain english', 'british english', 'formality', 'concise', 'kinder', 'warmer', 'second person', 'third person', 'punchy', 'trim this', 'rejection email', 'sound excited', 'error message']],
  // rag-answer: grounded-answer markers — source citations ('excerpt', 'policy:',
  // 'faq'…) and instruction frames ('answer from', 'using only'). Generic
  // 'from the'/'using the' were rejected: they steal agentic ops prompts.
  ['rag-answer', ['according to', 'context', 'document', 'passage', 'cite', 'source', 'excerpt', 'based on', 'from this', 'using this', 'using only', 'answer from', 'answer only', 'answer strictly', 'faq', 'policy', 'specs', 'warranty', 'menu', 'flyer', 'clause', 'handbook', 'newsletter', 'blurb', 'catalog', 'venue rules', 'syllabus', 'press release', 'incident report', 'comparison', 'transit notice', 'notice', 'api reference', 'course description']],
  // agentic-tool-use: checked LAST, so additions can only rescue prompts no
  // earlier group claimed — they cannot steal from any other cluster.
  ['agentic-tool-use', ['tool', 'api call', 'search the web', 'book', 'calendar', 'agent', 'inbox', 'unread', 'query the', 'database', 'call the', 'api', 'look up', 'send a', 'channel', 'portal', 'fetch', 'download', 'cancel', 'subscription', 'registrar', 'reminder', 'disk space', 'server', 'deploy', 'ticket', 'tracking', 'statement', 'drive', 'traffic', 'signups', 'analytics', 'wiki', 'restart', 'instances', 'recurring', 'nightly']],
];

/** Cluster used when no keyword matches. */
export const FALLBACK_CLUSTER = 'general';

/** Infer the seeded cluster id for a text via keyword matching (SPEC §4). */
export function seedClusterOf(text: string): string {
  const lower = text.toLowerCase();
  for (const [clusterId, keywords] of CLUSTER_KEYWORDS) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return clusterId;
    }
  }
  return FALLBACK_CLUSTER;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 (ADDITIVE): structured-answer fixtures for the strategy interpreters
// (SPEC §3). When a prompt explicitly requests a machine-readable answer, the
// mock responds in that exact format, deterministically from the seeded rng.
// Prompts that match NO marker below get the original word-bank text, so every
// pre-existing mock behavior and test is untouched.
// ─────────────────────────────────────────────────────────────────────────────

/** Marker: cascade self-report probe — "... format: CONFIDENCE: 0.xx". */
export const SELF_REPORT_MARKER = /CONFIDENCE:\s*0\.x/i;

/** Marker: judge prompts — "Respond with exactly one line: PICK: <index> ...". */
export const JUDGE_MARKER = /PICK:\s*<index>/i;

/** Marker: decompose prompts — "JSON array of subtasks" + the {"kind": ...} shape. */
export const DECOMPOSE_MARKER = /JSON array of subtasks/i;
export const DECOMPOSE_SHAPE_MARKER = /\{"kind"/;

/** Kind vocabulary for mock-decomposed subtasks (deterministic pick via rng). */
export const DECOMPOSE_KINDS = ['analysis', 'extraction', 'summary', 'general'] as const;

/**
 * Deterministic structured answer for strategy-interpreter prompts, or null
 * when the prompt matches no special marker (caller falls back to word-bank
 * text). Consumes rng draws ONLY when a marker matches, so the seeded stream
 * for ordinary prompts is bit-identical to Phase 0.
 *
 * - self-report: `CONFIDENCE: 0.xx` with value in [0.50, 0.99] from rng.
 * - judge: `PICK: <k>` with k in [0, max], max parsed from the prompt's "[0, N]".
 * - decompose: JSON array of 2–3 {"kind","prompt"} subtasks, kinds drawn from
 *   DECOMPOSE_KINDS, prompt text quoting a deterministic snippet of the task.
 */
export function specialFixtureText(
  model: string,
  promptText: string,
  rng: () => number,
): string | null {
  if (SELF_REPORT_MARKER.test(promptText)) {
    // Phase 3 (additive): corruption-aware self-report for EVAL prompts.
    const evalAware = evalSelfReportText(promptText, rng);
    if (evalAware !== null) return evalAware;
    const value = 0.5 + rng() * 0.49;
    return `CONFIDENCE: ${value.toFixed(2)}`;
  }
  if (JUDGE_MARKER.test(promptText)) {
    // Phase 3 (additive): corpus-aware candidate pick for EVAL prompts.
    const evalAware = evalJudgePickText(promptText, rng);
    if (evalAware !== null) return evalAware;
    const rangeMatch = /\[0,\s*(\d+)\]/.exec(promptText);
    const max = rangeMatch ? Number(rangeMatch[1]) : 0;
    const pick = Math.floor(rng() * (max + 1));
    return `PICK: ${pick}`;
  }
  if (DECOMPOSE_MARKER.test(promptText) && DECOMPOSE_SHAPE_MARKER.test(promptText)) {
    const count = 2 + Math.floor(rng() * 2); // 2 or 3 subtasks
    const snippet = promptText.replace(/\s+/g, ' ').slice(0, 80);
    const subtasks = [];
    for (let i = 0; i < count; i++) {
      const kind = DECOMPOSE_KINDS[Math.floor(rng() * DECOMPOSE_KINDS.length)] ?? 'general';
      subtasks.push({ kind, prompt: `[mock:${model}] subtask ${i} (${kind}) for: ${snippet}` });
    }
    return JSON.stringify(subtasks);
  }
  // Phase 3 (additive): harness llm-judge SCORE prompts, then corpus answers
  // for EVAL prompts (null → legacy word-bank text for everything else).
  if (SCORE_MARKER.test(promptText)) {
    return evalJudgeScoreText(model, promptText, rng);
  }
  return evalAnswerFixtureText(model, promptText, rng);
}

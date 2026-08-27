// Cluster assignment — deterministic lexical score reconciled with the
// extraction call's hint. Agreement → assigned; disagreement or a flat
// lexical signal with nothing to corroborate → cluster-uncertain, and the
// generator returns a draft with an open question instead of guessing
// (autopilot never fills a slot it cannot trace).
import type { TaxonomyCluster } from './interview.js';
import { TAXONOMY_CLUSTERS } from './interview.js';

/** Keyword descriptors per cluster — small, committed, deterministic. */
const DESCRIPTORS: Record<TaxonomyCluster, string[]> = {
  'agentic-tool-use': ['tool', 'tools', 'api', 'apis', 'automate', 'workflow', 'agent', 'browse', 'integrate'],
  classification: ['classify', 'categorize', 'label', 'sort', 'triage', 'route', 'tag', 'spam'],
  'code-gen': ['code', 'function', 'script', 'implement', 'program', 'write code', 'python', 'typescript', 'sql'],
  'code-review': ['review', 'pull request', 'pr', 'diff', 'lint', 'bug', 'refactor suggestion', 'code quality'],
  creative: ['story', 'poem', 'creative', 'brainstorm', 'slogan', 'marketing copy', 'name ideas', 'fiction'],
  extraction: ['extract', 'parse', 'fields', 'structured', 'invoice', 'form', 'json from', 'pull data', 'scrape'],
  'multi-step-reasoning': ['reason', 'plan', 'analyze', 'decide', 'compare', 'evaluate', 'multi-step', 'logic', 'math'],
  'rag-answer': ['question', 'answer', 'knowledge', 'docs', 'documentation', 'faq', 'lookup', 'search my'],
  'rewrite-edit': ['rewrite', 'edit', 'polish', 'rephrase', 'grammar', 'tone', 'shorten', 'proofread'],
  summarization: ['summarize', 'summary', 'digest', 'tldr', 'condense', 'brief', 'recap', 'minutes'],
};

export interface ClusterAssignment {
  outcome: 'assigned';
  clusterId: TaxonomyCluster;
  /** Why the assignment holds — rides the choice's provenance.
   * 'operator-answer': the generator asked (cluster-uncertain draft) and
   * the operator answered — the answer is authoritative. */
  basis: 'lexical+hint' | 'operator-answer';
  lexicalScore: number;
}

export interface ClusterUncertain {
  outcome: 'uncertain';
  /** Deduped, ordered: hint first, then lexical leaders. */
  candidates: TaxonomyCluster[];
  /** The open question the draft carries (review-visible, user-answerable). */
  question: string;
}

function lexicalScores(goal: string): Map<TaxonomyCluster, number> {
  const text = goal.toLowerCase();
  const scores = new Map<TaxonomyCluster, number>();
  for (const cluster of TAXONOMY_CLUSTERS) {
    let s = 0;
    for (const kw of DESCRIPTORS[cluster]) if (text.includes(kw)) s += 1;
    scores.set(cluster, s);
  }
  return scores;
}

/**
 * Reconcile the deterministic lexical signal with the model's hint.
 * Assignment REQUIRES agreement: the hint must match the lexical leader and
 * the leader must have a non-zero score. Everything else is uncertain —
 * including a flat-zero lexical field where the hint would stand alone
 * (wrong-but-confident is the failure mode this split exists to catch).
 */
export function assignCluster(goal: string, hint: TaxonomyCluster): ClusterAssignment | ClusterUncertain {
  const scores = lexicalScores(goal);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const leaderScore = ranked[0]![1];
  const coLeaders = ranked.filter(([, s]) => s === leaderScore).map(([c]) => c);

  if (leaderScore > 0 && coLeaders.includes(hint)) {
    return { outcome: 'assigned', clusterId: hint, basis: 'lexical+hint', lexicalScore: leaderScore };
  }
  const candidates = [...new Set<TaxonomyCluster>([hint, ...coLeaders.slice(0, 2), ranked[1]![0]])].slice(0, 3);
  return {
    outcome: 'uncertain',
    candidates,
    question:
      `I couldn't confidently place this mission. Which is closest to what it does: ` +
      candidates.join(', ') + `?`,
  };
}

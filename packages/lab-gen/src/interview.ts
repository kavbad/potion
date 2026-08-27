// The mission interview — four questions, one optional (the spec's minimum
// set; nothing else is asked, nothing unasked is inferred silently).
// Task-vs-standing is ASKED, never inferred: it is the one mislabel a model
// extraction would make confidently.

export interface InterviewAnswers {
  /** Q1: "What should it do?" — free text. */
  goal: string;
  /** Q2: task or standing — asked explicitly. */
  kind: 'task' | 'standing';
  /** Q2 (task only): "How will it know it's done?" */
  doneDefinition?: string;
  /** Q3: "Which accounts/services does it touch?" — may be empty.
   * Declarations only; tokens and config are Step 10 custody. */
  accounts: string[];
  /**
   * Q4: worth in dollars — PER RUN for tasks, PER CHECK/CYCLE for standing
   * missions (review outcome 1: a standing mission has no natural "run"
   * in the user's head; a check does). A leg IS a check, so the fuel
   * derivation is identical for both kinds.
   */
  worthUsd: number;
  /** Q5 (optional): "Anything it must never do?" — verbatim rules. */
  constraints?: string[];
  /**
   * The operator's answer to a cluster-uncertain draft: when the lexical
   * signal and the model hint could not agree, the generator ASKED — this
   * field is the answer coming back. Authoritative when present (the whole
   * point of asking), enum-bound at the API edge.
   */
  clusterChoice?: TaxonomyCluster;
}

/** The ten taxonomy clusters — the extraction hint enum and the
 * cluster-assignment universe. Pinned against the Step 5 suite map by test. */
export const TAXONOMY_CLUSTERS = [
  'agentic-tool-use',
  'classification',
  'code-gen',
  'code-review',
  'creative',
  'extraction',
  'multi-step-reasoning',
  'rag-answer',
  'rewrite-edit',
  'summarization',
] as const;

export type TaxonomyCluster = (typeof TAXONOMY_CLUSTERS)[number];

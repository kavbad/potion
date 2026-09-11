// Frontier Notes — the shapes an issue is built from (docs/FRONTIER-NOTES.md).
//
// FactSheet is the ONLY thing the writer model ever sees. It is composed from
// the Observatory run and the replay findings by code that knows the
// never-name list and the permitted fields; everything downstream inherits
// that discipline, and the redaction pass is the backstop.

export type ClusterFamily = 'code' | 'structured output' | 'reasoning' | 'retrieval' | 'writing';

export interface ClusterFact {
  clusterId: string;
  family: ClusterFamily;
  /** The routed pick's public name, or the literal 'name withheld'. */
  pick: string;
  storedQuality: number;
  storedCi95: number;
  observedMean: number | null;
  n: number;
  verdict: 'ok' | 'drift' | 'inconclusive';
}

export interface AuditionFact {
  alias: string;
  clusterId: string;
  lane: string;
  outcome: 'earned a frontier slot' | 'did not beat the incumbent' | 'not measurable';
}

export interface MixingFact {
  /** Absent when the finding is vague: the writer must not know which cluster. */
  clusterId?: string;
  family: ClusterFamily;
  /**
   * 'cheaper-and-as-good' beats or ties the best single on quality and is
   * strictly cheaper.
   *
   * 'no-win' is a MEASURED NEGATIVE RESULT: a mixture that was run properly
   * and did not beat the best single. compose.ts never produces one — it only
   * looks at recipes that already won — but a close note reports the losses
   * too, and the vocabulary had no way to say so. A union that can only
   * express wins invites writing 'frontier-candidate' over a mixture whose
   * costSaving is -0.12, which is the caption-vs-provenance failure the
   * honest-numbers rule exists to stop. Read `shape` for what was tried and
   * qualityDeltaVsBestSingle / costSaving for how it did.
   */
  kind: 'cheaper-and-as-good' | 'frontier-candidate' | 'no-win';
  /** The strategy shape measured ('judge-picked pair', 'confidence-escalated').
   *  Descriptive only — never identity, and never a substitute for `kind`. */
  shape?: string;
  meanQuality: number;
  qualityDeltaVsBestSingle: number;
  /** Fraction cheaper than the best single model (0.38 = 38% cheaper). */
  costSaving: number;
  n: number;
  /** When true the writer must use the family and a cost BAND, never the cluster or the exact ratio. */
  vague: boolean;
  costBand: string;
}

export interface FactSheet {
  week: string;
  at: string;
  frontier: ClusterFact[];
  auditions: AuditionFact[];
  mixing: MixingFact[];
  numbers: {
    canaries: number;
    clustersHeld: number;
    clustersMoved: number;
    inconclusive: number;
    itemsGraded: number;
    candidatesScreened: number;
    candidatesMeasured: number;
    spendUsd: number;
  };
  /** Caveats the issue must carry verbatim in substance. */
  caveats: string[];
}

export interface IssueFaq {
  q: string;
  a: string;
}

export interface Issue {
  slug: string;
  /** The issue's address: an ISO week ('2026-W36') for a weekly, a UTC day
   * ('2026-09-03') for a daily ledger (F6). */
  week: string;
  /** F6: 'daily' is the ledger note — body paragraphs, no FactSheet.
   * Absent = the weekly issue, byte-identical to every prior record. */
  kind?: 'weekly' | 'daily';
  /** F6: the daily ledger's paragraphs, '\n\n'-joined — the shape the
   * issue page has rendered dailies from since C3. */
  body?: string;
  /** F8: the agenda item this piece answers. The corpus is the cooldown's
   * memory — an issue records the claim it spent so tomorrow's agenda can
   * decline to repeat it. */
  agenda?: {
    id: string;
    kind: string;
    clusterId: string;
    demandQuery: string;
    score: number;
    /** cluster + models — set at publish so the whole claim cools. */
    claimKey?: string;
  };
  title: string;
  /** One-paragraph summary (meta description, RSS, index card). */
  summary: string;
  publishedAt: string;
  byline: string;
  /** Plain-English summary for a reader who knows nothing about AI models. */
  plain: string;
  lede: string;
  frontierNote: string;
  auditionNote: string;
  mixingNote: string;
  /** Why a buyer should care. */
  takeaway: string;
  method: string;
  faq: IssueFaq[];
  /** null on a daily ledger (F6): the day's numbers live in `body`, and a
   * daily has no weekly frontier table. */
  facts: FactSheet | null;
  status: 'published' | 'held';
  heldReason?: string;
  /** F2 (docs/RESEARCH-FLEET.md R3): the Action Gateway's decision on the
   * publish act — recorded on the issue, fingerprint-bound to its content.
   * 'allow' published it (audit = standing sampled audit; priorResolution
   * = an operator's allow-once on this exact draft); 'hold'/'blocked' kept
   * it held. Absent = published before the gate existed, or gate not
   * configured. */
  publishGate?: {
    decision: 'allow' | 'hold' | 'blocked';
    audit?: boolean;
    runId: string;
    actionId: string;
    argsHash: string;
    priorResolution?: boolean;
  };
  /** `runId` (F0, docs/RESEARCH-FLEET.md R2): when a Delta worker run wrote
   * the draft, the recorded run that backs the byline — credits derive from
   * records, never captions. `verifiedBy` (F1): the Auditor run whose PASS
   * verdict let the model-written draft publish — the "Verified by Auditor"
   * line's evidence. */
  writer: { model: string; costUsd: number; receipt?: WriterReceipt; runId?: string; verifiedBy?: { runId: string; costUsd: number } } | null;
  /**
   * Corrections to a published issue, oldest first (2026-09-10).
   *
   * The author page promised readers that every correction would be listed
   * permanently, next to a hardcoded "no corrections on record" — so it would
   * have kept saying that through any number of them. The first real one, an
   * item count published as a model count, is what made the promise false
   * rather than merely decorative. A corrected issue keeps its address and
   * carries the correction in its own body: the record is amended in public,
   * never quietly rewritten.
   */
  corrections?: IssueCorrection[];
}

/** A published claim that was wrong, and what replaced it. Mirrored in
 *  apps/dashboard/lib/research.ts — the dashboard never bundles workers. */
export interface IssueCorrection {
  /** ISO instant the correction was made, not when the error published. */
  at: string;
  was: string;
  now: string;
  /** Why it happened, in the author's own accounting. */
  why?: string;
}

/** What Potion's own API said about the request that wrote the issue — the dogfood receipt. */
export interface WriterReceipt {
  /** The kind of work Potion classified the writing request as. */
  cluster: string;
  /** First 8 characters of the strategy hash it served. */
  strategy8: string;
  policy: string;
  provenance: string;
  promptTokens: number;
  completionTokens: number;
}

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
  /** 'cheaper-and-as-good' beats or ties the best single on quality and is strictly cheaper. */
  kind: 'cheaper-and-as-good' | 'frontier-candidate';
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
  week: string;
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
  facts: FactSheet;
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

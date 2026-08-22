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
  lede: string;
  frontierNote: string;
  auditionNote: string;
  mixingNote: string;
  method: string;
  faq: IssueFaq[];
  facts: FactSheet;
  status: 'published' | 'held';
  heldReason?: string;
  writer: { model: string; costUsd: number } | null;
}

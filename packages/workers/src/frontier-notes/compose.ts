// Frontier Notes — compose the fact sheet (docs/FRONTIER-NOTES.md).
//
// Pure. Takes the Observatory run and the replay findings, applies the
// never-name list and the breakthrough rule, and returns only what an issue
// may say. No prose is written here; that is write.ts. The one judgement
// call this file makes is `vague`: a mixing finding large enough that cluster
// + exact ratio would hand the recipe to a reader gets widened to a family
// and a band.

import type { ObservatoryRun } from '../observatory.js';
import type { ClusterReplay, Recipe } from '../replay.js';
import { NEVER_NAME } from './redact.js';
import type { AuditionFact, ClusterFact, ClusterFamily, FactSheet, MixingFact } from './types.js';

export const FAMILY_BY_CLUSTER: Record<string, ClusterFamily> = {
  'code-gen': 'code',
  'code-review': 'code',
  extraction: 'structured output',
  classification: 'structured output',
  'multi-step-reasoning': 'reasoning',
  'agentic-tool-use': 'reasoning',
  'rag-answer': 'retrieval',
  summarization: 'writing',
  'rewrite-edit': 'writing',
  creative: 'writing',
};

export function familyOf(clusterId: string): ClusterFamily {
  return FAMILY_BY_CLUSTER[clusterId] ?? 'reasoning';
}

function isWithheld(model: string, extra: readonly string[]): boolean {
  const m = model.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return [...NEVER_NAME, ...extra].some((n) => {
    const k = n.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return k.length > 2 && m.includes(k);
  });
}

/** Public name or the literal 'name withheld'. */
export function publicName(model: string, extra: readonly string[] = []): string {
  return isWithheld(model, extra) ? 'name withheld' : model;
}

/**
 * A mixing finding is "large" — and therefore vague — when it is cheaper
 * and as good by more than a third, or a frontier candidate that beats the
 * best single by more than two points. Those are the findings a competitor
 * would try to reproduce from the issue.
 */
export function isLargeFinding(r: Pick<Recipe, 'cheaperAndAsGood' | 'costSavingVsBestSingle' | 'qualityDeltaVsBestSingle'>): boolean {
  if (r.cheaperAndAsGood && r.costSavingVsBestSingle > 1 / 3) return true;
  if (r.qualityDeltaVsBestSingle > 0.02) return true;
  return false;
}

export function costBand(saving: number): string {
  const ratio = 1 / Math.max(1e-6, 1 - saving);
  if (ratio < 1.5) return 'under 1.5× cheaper';
  if (ratio < 2) return 'between 1.5× and 2× cheaper';
  if (ratio < 4) return 'between 2× and 4× cheaper';
  if (ratio < 8) return 'between 4× and 8× cheaper';
  return 'more than 8× cheaper';
}

export interface ComposeOptions {
  extraNeverName?: readonly string[];
  /** Items graded this week, when known (canary sample n × canaries otherwise). */
  itemsGraded?: number;
}

export function composeFactSheet(run: ObservatoryRun, replays: ClusterReplay[], opts: ComposeOptions = {}): FactSheet {
  const extra = opts.extraNeverName ?? [];

  const frontier: ClusterFact[] = run.canaries
    .map((c) => ({
      clusterId: c.clusterId,
      family: familyOf(c.clusterId),
      pick: publicName(c.model, extra),
      storedQuality: round3(c.storedQuality),
      storedCi95: round3(c.storedCi95),
      observedMean: c.observedMean === null ? null : round3(c.observedMean),
      n: c.n,
      verdict: c.verdict,
    }))
    .sort((a, b) => a.clusterId.localeCompare(b.clusterId));

  const auditions: AuditionFact[] = run.auditions.map((a) => ({
    alias: publicName(a.alias, extra),
    clusterId: a.clusterId,
    lane: a.lane,
    outcome: a.earnedSlot === true ? 'earned a frontier slot' : a.earnedSlot === false ? 'did not beat the incumbent' : 'not measurable',
  }));

  const mixing: MixingFact[] = [];
  for (const r of replays) {
    const best = r.recipes.find((x) => x.kind !== 'oracle' && (x.cheaperAndAsGood || x.frontierCandidate));
    if (!best) continue;
    const vague = isLargeFinding(best);
    mixing.push({
      ...(vague ? {} : { clusterId: r.clusterId }),
      family: familyOf(r.clusterId),
      kind: best.cheaperAndAsGood ? 'cheaper-and-as-good' : 'frontier-candidate',
      meanQuality: round3(best.meanQuality),
      qualityDeltaVsBestSingle: round3(best.qualityDeltaVsBestSingle),
      costSaving: round3(best.costSavingVsBestSingle),
      n: best.n,
      vague,
      costBand: costBand(best.costSavingVsBestSingle),
    });
  }
  mixing.sort((a, b) => b.costSaving - a.costSaving);

  const held = frontier.filter((f) => f.verdict === 'ok').length;
  const moved = frontier.filter((f) => f.verdict === 'drift').length;
  const inconclusive = frontier.filter((f) => f.verdict === 'inconclusive').length;

  const caveats = [
    'Every quality figure is a mean over a retrieval-hostile suite with a bootstrap 95% interval; two points whose intervals overlap are reported as tied.',
    'Code-generation and code-review quality is scored by executing the code; other clusters are scored by a rubric against a reference answer.',
    'A canary is a small weekly sample (four items) against the stored measurement; it detects collapse, not one-point movement.',
    'Combinations of models are replayed from stored item-level results; agreement between models is modelled conservatively, so the combination figures understate rather than overstate.',
  ];
  if (run.catalogue.freeTierExcluded > 0) {
    caveats.push('Free-tier listings are excluded from auditions: their quality is not stable enough to measure.');
  }

  return {
    week: run.week,
    at: run.at,
    frontier,
    auditions,
    mixing,
    numbers: {
      canaries: run.canaries.length,
      clustersHeld: held,
      clustersMoved: moved,
      inconclusive,
      itemsGraded: opts.itemsGraded ?? run.canaries.reduce((s, c) => s + c.n, 0),
      candidatesScreened: run.catalogue.newSinceRegistry,
      candidatesMeasured: run.auditions.filter((a) => !a.error).length,
      spendUsd: Math.round(run.spendUsd * 100) / 100,
    },
    caveats,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

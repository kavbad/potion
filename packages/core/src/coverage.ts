// COVERAGE (S7 L3) — where "we have never tested for this" becomes a number
// with a reason attached.
//
// S6 widened what is measured; nothing said WHICH gap mattered. G5 records
// the state honestly — roughly three measured strategies per cluster — and
// frames it as a budget question, but a budget question with no ranking is
// answered by whoever is in the room. This module answers it from demand:
// what customers actually send, against what has actually been measured.
//
// TWO DESIGN RULES.
//
//   The reason is DATA, not prose. `no_tool_capable_point` is a fact another
//   job can act on — it names the filter L4's probe must apply when it picks
//   candidates. A sentence would need a human in between.
//
//   Absence of evidence is not coverage. A cluster whose models report NO
//   context length does not thereby satisfy a long-context cell; unknown
//   capability is treated as uncovered, because the alternative is routing
//   a 60k-token prompt at a model nobody checked can hold it.
import { charBucketMax, parseShapeClass } from './shape.js';
import type { StrategyConfig, ProgramNode, ProgramCheck } from './types.js';

/** Measured points a cluster needs before its evidence stops being thin. */
export const MIN_MEASURED_POINTS = 3;

/** Rough characters per token. Deliberately coarse — it decides a bucket. */
export const CHARS_PER_TOKEN = 4;

export type CoverageReason =
  | 'covered'
  /** The traffic matched no cluster well enough to route (an `lsh:` bucket). */
  | 'unassigned_region'
  /** The cluster has no live-provenance measured points at all. */
  | 'no_live_points'
  /** Tool-carrying traffic, and no single measured point is tool-capable. */
  | 'no_tool_capable_point'
  /** The cell's requests can exceed every measured model's context window. */
  | 'context_too_short'
  /** Measured, but on fewer points than a real choice needs. */
  | 'thin_evidence';

/** How much worse each reason is than being covered. */
export const REASON_SEVERITY: Record<CoverageReason, number> = {
  covered: 0,
  no_live_points: 1,
  no_tool_capable_point: 0.9,
  context_too_short: 0.8,
  unassigned_region: 0.7,
  thin_evidence: 0.4,
};

export interface CoverageCell {
  bucket: string;
  bucketKind: 'cluster' | 'unassigned';
  shapeClass: string;
  requests: number;
  orgCount: number;
}

export interface CoverageEvidence {
  /** Live-provenance points on the cluster's current platform frontier. */
  livePoints: number;
  /** Live SINGLE points whose model is KNOWN tool-capable. Single only:
   * tool-carrying requests are narrowed to single points on the serve path
   * (routes/chat.ts), so a tool-capable cascade would never be selected. */
  toolCapablePoints: number;
  /** Largest KNOWN context window among the measured points' models, or null
   * when no measured model reports one. Null is not "big enough". */
  maxContextTokens: number | null;
}

export interface CoverageVerdict {
  reason: CoverageReason;
  covered: boolean;
  /** Ranking score: demand × breadth × severity. 0 when covered. */
  score: number;
  /** Worst-case prompt size this cell can contain, in tokens. */
  requiredContextTokens: number;
}

/**
 * Assess one demand cell against the evidence that would serve it.
 *
 * `evidence` is null when the cluster has no frontier at all — the same
 * verdict as an empty one, because both mean nothing measured is selectable.
 */
export function assessCoverage(
  cell: CoverageCell,
  evidence: CoverageEvidence | null,
): CoverageVerdict {
  const shape = parseShapeClass(cell.shapeClass);
  const charsMax = shape === null ? Number.POSITIVE_INFINITY : charBucketMax(shape.chars);
  // The bucket's UPPER edge: a cell labelled 16k-64k contains requests up to
  // 64k characters, and coverage has to hold for the largest of them.
  const requiredContextTokens = Number.isFinite(charsMax)
    ? Math.ceil(charsMax / CHARS_PER_TOKEN)
    : Math.ceil(256_000 / CHARS_PER_TOKEN);

  const verdict = (reason: CoverageReason): CoverageVerdict => ({
    reason,
    covered: reason === 'covered',
    score: reason === 'covered' ? 0 : cell.requests * cell.orgCount * REASON_SEVERITY[reason],
    requiredContextTokens,
  });

  // An unassigned region is uncovered by construction: routing never chose a
  // cluster for it, so no cluster's evidence is the evidence for it.
  if (cell.bucketKind === 'unassigned') return verdict('unassigned_region');
  if (evidence === null || evidence.livePoints === 0) return verdict('no_live_points');
  if (shape?.tools === true && evidence.toolCapablePoints === 0) {
    return verdict('no_tool_capable_point');
  }
  // Unknown context is uncovered, not covered: nobody checked.
  if (evidence.maxContextTokens === null || evidence.maxContextTokens < requiredContextTokens) {
    return verdict('context_too_short');
  }
  if (evidence.livePoints < MIN_MEASURED_POINTS) return verdict('thin_evidence');
  return verdict('covered');
}

/**
 * Every model alias a strategy would call.
 *
 * Coverage asks capability questions of a POINT, and a point is a strategy,
 * not a model: an ensemble's context window is its smallest member's, and a
 * cascade is tool-incapable regardless of what its stages support. Answering
 * those questions needs the members enumerated, so this is the one place
 * that knows how each strategy shape names them.
 */
/** Every model a program can call (leaf calls + judge models), in order, deduplicated. */
export function programModels(node: ProgramNode): string[] {
  const out: string[] = [];
  const add = (m: string) => { if (!out.includes(m)) out.push(m); };
  const walkCheck = (c: ProgramCheck): void => {
    if (c.kind === 'agree') { walk(c.of[0]); walk(c.of[1]); } else walk(c.of);
  };
  const walk = (n: ProgramNode): void => {
    switch (n.op) {
      case 'call': add(n.model); return;
      case 'if': walkCheck(n.check); walk(n.then); walk(n.else); return;
      case 'vote': n.of.forEach(walk); return;
      case 'pick': n.of.forEach(walk); if (n.by.kind === 'judge') add(n.by.model); return;
    }
  };
  walk(node);
  return out;
}

/** Static call bound: the number of DISTINCT call nodes (by identity) plus
 *  judge picks — exactly what a worst-case execution pays for, because the
 *  interpreter memoizes per node (a call referenced from a check and again
 *  from a branch executes once). */
export function programCallCount(node: ProgramNode): number {
  const seen = new Set<ProgramNode>();
  let judges = 0;
  const walkCheck = (c: ProgramCheck): void => {
    if (c.kind === 'agree') { walk(c.of[0]); walk(c.of[1]); } else walk(c.of);
  };
  const walk = (x: ProgramNode): void => {
    if (seen.has(x)) return;
    seen.add(x);
    switch (x.op) {
      case 'call': return;
      case 'if': walkCheck(x.check); walk(x.then); walk(x.else); return;
      case 'vote': x.of.forEach(walk); return;
      case 'pick': x.of.forEach(walk); if (x.by.kind === 'judge') judges++; return;
    }
  };
  walk(node);
  return [...seen].filter((n) => n.op === 'call').length + judges;
}

export function strategyModels(config: StrategyConfig): string[] {
  switch (config.type) {
    case 'single':
      return [config.model];
    case 'best-of-n':
      return [config.model];
    case 'cascade':
      return config.stages.map((s) => s.model);
    case 'draft-verify':
      return [config.draftModel, config.verifierModel];
    case 'ensemble':
      return [...config.models];
    case 'decompose':
      return [config.decomposerModel, ...Object.values(config.routing)];
    case 'composite':
      return [config.startModel, config.upgradeModel];
    case 'program':
      return programModels(config.body);
  }
}

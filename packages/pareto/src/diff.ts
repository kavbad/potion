// Frontier diffing (SPEC §1 FrontierDiff): set-level movement by strategyHash
// (appeared / vanished), dominance-level explanation (dominatedBy pairs), and
// a plain-English `narrative` a buyer could read.
import type { Frontier, FrontierDiff, FrontierPoint, StrategyConfig } from '@potion/core';
import { DOMINANCE_EPSILON, isDominated } from './dominance.js';

/** Short human label for a strategy config, e.g. `cascade(cheap-class→frontier-class)`. */
export function describeStrategy(cfg: StrategyConfig): string {
  switch (cfg.type) {
    case 'single':
      return `single(${cfg.model})`;
    case 'cascade':
      return `cascade(${cfg.stages.map((s) => s.model).join('→')})`;
    case 'best-of-n':
      return `best-of-n(${cfg.model}×${cfg.n}, judge ${cfg.judge.model})`;
    case 'draft-verify':
      return `draft-verify(${cfg.draftModel}→${cfg.verifierModel})`;
    case 'ensemble': {
      const judge = cfg.fusion.judge ? `, judge ${cfg.fusion.judge.model}` : '';
      return `ensemble(${cfg.models.join('+')}${judge})`;
    }
    case 'decompose':
      return `decompose(${cfg.decomposerModel})`;
    case 'composite': // M3 #23 (SPEC §12.6)
      return `composite(${cfg.startModel}→${cfg.upgradeModel}@<${cfg.upgradeIf.confidenceBelow})`;
  }
}

/** "quality 0.82 at $2.10/1K, p95 2400ms" */
export function formatPoint(p: FrontierPoint): string {
  return `quality ${p.quality.toFixed(2)} at $${p.costPer1K.toFixed(2)}/1K, p95 ${Math.round(p.latencyP95)}ms`;
}

/** Buyer-readable comparison of dominator vs dominated point. */
function advantagesOf(dominator: FrontierPoint, point: FrontierPoint): string {
  const eps = DOMINANCE_EPSILON;
  const parts: string[] = [];
  if (dominator.costPer1K < point.costPer1K - eps) parts.push('cheaper');
  if (dominator.quality > point.quality + eps) parts.push('higher quality');
  if (dominator.latencyP95 < point.latencyP95 - eps) parts.push('lower p95 latency');
  if (parts.length === 0) return 'at least as good on every axis';
  return parts.join(' and ');
}

/**
 * diffFrontiers(from, to) → FrontierDiff.
 *
 * - appeared:   points in `to` whose strategyHash is absent from `from`.
 * - vanished:   points in `from` whose strategyHash is absent from `to`.
 * - dominatedBy: each `from` point that is now dominated by some point in
 *   `to`, paired with its dominator. In the normal recompute flow (`to` =
 *   re-computed frontier over old ∪ new candidates) these are exactly the
 *   vanished points with a visible cause; a vanished point CAN lack a
 *   dominator here (e.g. it simply was not re-evaluated), so the two lists
 *   are computed independently.
 * - narrative:  one sentence per movement; a single "no change" sentence for
 *   an empty diff.
 */
export function diffFrontiers(from: Frontier, to: Frontier): FrontierDiff {
  const fromHashes = new Set(from.points.map((p) => p.strategyHash));
  const toHashes = new Set(to.points.map((p) => p.strategyHash));

  const appeared = to.points.filter((p) => !fromHashes.has(p.strategyHash));
  const vanished = from.points.filter((p) => !toHashes.has(p.strategyHash));

  const dominatedBy: FrontierDiff['dominatedBy'] = [];
  for (const p of from.points) {
    const dominator = isDominated(p, to.points);
    if (dominator !== null) dominatedBy.push({ point: p, dominatedBy: dominator });
  }

  const narrative: string[] = [];
  for (const p of appeared) {
    narrative.push(
      `Strategy ${describeStrategy(p.strategyConfig)} is new on the frontier: ${formatPoint(p)}.`,
    );
  }
  const dominatorByHash = new Map(
    dominatedBy.map(({ point, dominatedBy: d }) => [point.strategyHash, d]),
  );
  for (const p of vanished) {
    const d = dominatorByHash.get(p.strategyHash);
    if (d) {
      narrative.push(
        `${describeStrategy(p.strategyConfig)} fell off the frontier — dominated by ` +
          `${describeStrategy(d.strategyConfig)}, which is ${advantagesOf(d, p)} ` +
          `(${formatPoint(d)}).`,
      );
    } else {
      narrative.push(
        `${describeStrategy(p.strategyConfig)} fell off the frontier ` +
          `(no longer among the non-dominated strategies).`,
      );
    }
  }
  if (narrative.length === 0) {
    narrative.push(
      `No change: the frontier is identical between v${from.version} and v${to.version}.`,
    );
  }

  return {
    clusterId: to.clusterId,
    fromVersion: from.version,
    toVersion: to.version,
    appeared,
    vanished,
    dominatedBy,
    narrative,
  };
}

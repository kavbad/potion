// THE CLASSIFICATION-DIFF GATE (Step 11 review addition 2).
//
// Reclassifying a tool from `act` to `read` REMOVES a permission prompt —
// the pore stops firing for that tool. That is a security-relevant edit and
// it must never be silent. The gate: a committed BASELINE records every
// package's (version, contentHash, per-tool action). If a tool loses its
// pore — act → read, or a tool disappearing, or a package's tools changing
// at all — the suite FAILS unless the package's version AND contentHash
// both moved in the same commit.
//
// Why both: the contentHash moves automatically with any content edit (so
// it alone cannot be forgotten), and the VERSION is the human-readable
// declaration that the author knew what they were doing. Requiring both
// makes "I removed a pore" impossible to do by accident and impossible to
// hide in a diff — the baseline file is the visible record.
//
// This is the Step 9 audit-table discipline pointed at permissions: the
// thing that must not drift silently is pinned by a committed artifact
// whose disagreement is a test failure.
import baseline from '../baseline/classification.json' with { type: 'json' };
import { packageContentHash, type SuperpowerPackage } from './format.js';

export interface BaselineEntry {
  version: string;
  contentHash: string;
  /** tool name → action, as of the baseline. */
  actions: Record<string, 'read' | 'act'>;
}

export const CLASSIFICATION_BASELINE = baseline as unknown as Record<string, BaselineEntry>;

export interface ClassificationDiff {
  packageId: string;
  /** The pore-affecting changes, each named. */
  poreRemovals: string[];
  /** Any other classification movement (read → act, added, removed). */
  otherChanges: string[];
  versionChanged: boolean;
  hashChanged: boolean;
  /** true when a pore was removed WITHOUT the version+hash declaration. */
  silentPoreRemoval: boolean;
}

/**
 * Compare a package against the committed baseline. A package absent from
 * the baseline is NEW: no pore was removed (there was nothing to remove),
 * so it passes — the baseline gains it on the next regeneration.
 */
export function diffClassification(
  pkg: SuperpowerPackage,
  base: Record<string, BaselineEntry> = CLASSIFICATION_BASELINE,
): ClassificationDiff {
  const prior = base[pkg.id];
  const hash = packageContentHash(pkg);
  if (prior === undefined) {
    return {
      packageId: pkg.id,
      poreRemovals: [],
      otherChanges: ['new package (absent from the baseline)'],
      versionChanged: true,
      hashChanged: true,
      silentPoreRemoval: false,
    };
  }
  const now = new Map(pkg.tools.map((t) => [t.name, t.action] as const));
  const poreRemovals: string[] = [];
  const otherChanges: string[] = [];
  for (const [name, wasAction] of Object.entries(prior.actions)) {
    const isAction = now.get(name);
    if (isAction === undefined) {
      // A removed ACT tool also removes a pore-bearing capability; a removed
      // read tool is an ordinary catalog edit.
      if (wasAction === 'act') poreRemovals.push(`${name}: act tool removed`);
      else otherChanges.push(`${name}: read tool removed`);
      continue;
    }
    if (wasAction === 'act' && isAction === 'read') {
      poreRemovals.push(`${name}: act → read (the pore stops firing)`);
    } else if (wasAction === 'read' && isAction === 'act') {
      otherChanges.push(`${name}: read → act (a pore was ADDED — always allowed)`);
    }
  }
  for (const [name] of now) {
    if (!(name in prior.actions)) otherChanges.push(`${name}: new tool`);
  }
  const versionChanged = prior.version !== pkg.version;
  const hashChanged = prior.contentHash !== hash;
  return {
    packageId: pkg.id,
    poreRemovals,
    otherChanges,
    versionChanged,
    hashChanged,
    // The gate: a pore removal REQUIRES both declarations in the same commit.
    silentPoreRemoval: poreRemovals.length > 0 && !(versionChanged && hashChanged),
  };
}

/** Thrown when a regeneration would launder a pore removal (see below). */
export class SilentPoreRemovalError extends Error {
  constructor(readonly packageId: string, readonly removals: string[]) {
    super(
      `refusing to regenerate the classification baseline: '${packageId}' removes a pore ` +
        `(${removals.join('; ')}) without a version bump. Bump the package version in the SAME ` +
        `commit — removing a permission prompt is a declared act, never a regeneration side effect.`,
    );
    this.name = 'SilentPoreRemovalError';
  }
}

/**
 * Regenerate the baseline (the deliberate, reviewable act).
 *
 * STEP 11 REVIEW FINDING — the gate used to be unenforceable from this side:
 * `buildBaseline` read only the catalog, so an author who removed a pore and
 * then did exactly what the failing test told them to ("regenerate the
 * baseline") rewrote version + hash + actions together, and every check
 * passed with the version untouched. The regeneration WAS the laundering
 * path.
 *
 * So the prior baseline is now an INPUT, and regeneration REFUSES to write a
 * pore removal whose version did not move. The gate is enforced on both
 * sides: the suite fails on the drift, and the fix-it command fails too
 * until the author declares the change.
 */
export function buildBaseline(
  catalog: readonly SuperpowerPackage[],
  prior: Record<string, BaselineEntry> = CLASSIFICATION_BASELINE,
): Record<string, BaselineEntry> {
  const out: Record<string, BaselineEntry> = {};
  for (const pkg of [...catalog].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const diff = diffClassification(pkg, prior);
    if (diff.poreRemovals.length > 0 && !diff.versionChanged) {
      throw new SilentPoreRemovalError(pkg.id, diff.poreRemovals);
    }
    out[pkg.id] = {
      version: pkg.version,
      contentHash: packageContentHash(pkg),
      actions: Object.fromEntries(
        [...pkg.tools].sort((a, b) => (a.name < b.name ? -1 : 1)).map((t) => [t.name, t.action]),
      ),
    };
  }
  return out;
}

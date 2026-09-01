// G0 (2026-08-31, external core-API review) — serve-time router-version
// stamping. The receipt names the version that ACTUALLY served, decided in
// the moment: while a request is being served, the latest minted artifact
// is consulted and its version is stamped only when its recorded assignment
// for this cluster is exactly the decision being served (full strategy hash
// + frontier version — stronger than the read-time reconstruction's 8-char
// prefix, and immune to its newest-match-wins misattribution when a later
// version happens to contain the same assignment).
//
// No match is an honest null: routing drifted since the last mint, or none
// was ever minted. Read-time reconstruction (routerVersionForRequest)
// remains the backfill for exactly those rows.
//
// The cache exists because the artifact document is a jsonb blob that must
// not be fetched on every request; the TTL covers mints from other
// instances, and compileAndMintRouter busts it in-process the moment a new
// version is minted.
import { latestRouterVersion, type PotionDb } from '@potion/db';
import type { RouterAssignment } from './compile-router.js';

const TTL_MS = 15_000;

interface CachedArtifact {
  version: number;
  assignments: RouterAssignment[];
}

const cache = new Map<string, { artifact: CachedArtifact | null; at: number }>();

/** Called by compileAndMintRouter when a NEW version is minted, so the next
 * served request stamps the fresh version without waiting out the TTL. */
export function bustRouterStampCache(orgId: string): void {
  cache.delete(orgId);
}

/** The router version to stamp on a serving request, or null when no minted
 * artifact contains exactly this assignment. Never throws — a stamping
 * failure must not touch the serve path, and null already means "unproven". */
export async function stampedRouterVersion(
  db: PotionDb,
  orgId: string,
  served: { clusterId: string; strategyHash: string; frontierVersion: number },
): Promise<number | null> {
  let artifact: CachedArtifact | null | undefined;
  const hit = cache.get(orgId);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) artifact = hit.artifact;
  if (artifact === undefined) {
    try {
      const latest = await latestRouterVersion(db, orgId);
      artifact =
        latest === null
          ? null
          : {
              version: latest.version,
              assignments: (latest.document as { assignments?: RouterAssignment[] }).assignments ?? [],
            };
    } catch {
      return null;
    }
    cache.set(orgId, { artifact, at: Date.now() });
  }
  if (artifact === null) return null;
  const match = artifact.assignments.some(
    (a) =>
      a.clusterId === served.clusterId &&
      a.strategyHash === served.strategyHash &&
      a.frontierVersion === served.frontierVersion,
  );
  return match ? artifact.version : null;
}

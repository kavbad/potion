// Provenance presentation helpers (ROADMAP M1a items 4/5) — pure functions
// so they are unit-testable without React/jsdom. Rule: only provider_mode
// 'live' may ever be presented as live evidence; 'mock' AND 'unknown' badge
// SIMULATED.
//
// NOTE (M2 Wave 2, ROADMAP #16): the M1a BYOK honesty banner is GONE — key
// custody shipped (AES-256-GCM envelope encryption at rest; BYOK keys serve
// their org). The connect-keys page now states the custody facts instead.
import type { FrontierClusterDto, FrontierPointDto, PointProvenance } from './types';

/** Custody note shown on the connect-keys page (M2 #16). */
export const CUSTODY_NOTE =
  'Keys are encrypted at rest (AES-256-GCM, envelope) and used to serve your org’s traffic.';

/** True when a point must be badged SIMULATED (amber) rather than LIVE. */
export function isSimulated(mode: PointProvenance | undefined): boolean {
  return mode !== 'live';
}

/** Badge label for a single frontier point. */
export function pointBadgeLabel(mode: PointProvenance | undefined): 'SIMULATED' | 'LIVE' {
  return isSimulated(mode) ? 'SIMULATED' : 'LIVE';
}

/** One-line provenance summary for the /frontiers page header, e.g.
 * "SIMULATED — 3 of 3 points measured on mock providers". */
export function clusterProvenanceSummary(cluster: FrontierClusterDto): string {
  const { live, simulated } = cluster.provenance;
  const total = live + simulated;
  if (total === 0) return 'NO EVIDENCE — frontier has no points';
  if (simulated === 0) return `LIVE — all ${total} point${total === 1 ? '' : 's'} from live providers`;
  if (live === 0) {
    return `SIMULATED — ${simulated} of ${total} point${total === 1 ? '' : 's'} measured on mock providers (or unlabeled)`;
  }
  return `MIXED — ${live} live, ${simulated} simulated of ${total} points`;
}

/** Badge label for the whole cluster: SIMULATED unless every point is live. */
export function clusterBadgeLabel(cluster: FrontierClusterDto): 'SIMULATED' | 'LIVE' | 'MIXED' {
  const { live, simulated } = cluster.provenance;
  if (live > 0 && simulated > 0) return 'MIXED';
  if (live > 0) return 'LIVE';
  return 'SIMULATED';
}

/** Worst-case provenance across a point list (for header summaries computed
 * from a frontier detail response rather than the list endpoint). */
export function pointsProvenance(points: FrontierPointDto[]): { live: number; simulated: number } {
  return {
    live: points.filter((p) => p.providerMode === 'live').length,
    simulated: points.filter((p) => p.providerMode !== 'live').length,
  };
}

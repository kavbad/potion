// Quality-guarantee helpers (M3 #22, SPEC §12.5): shape the
// /api/guarantee/status payload for the /frontiers breach badge and the
// /reports incidents table. The status API repeats the same incident list
// under every guarantee-carrying policy, so everything here dedupes by
// incident id.
import type { GuaranteeStatusDto, IncidentDto } from './types';

/** All incidents across the status payload, deduped by id (unresolved
 * first — the API already orders each policy's list that way). */
export function collectIncidents(status: GuaranteeStatusDto | null): IncidentDto[] {
  const byId = new Map<string, IncidentDto>();
  for (const policy of status?.policies ?? []) {
    for (const incident of policy.breaches) {
      if (!byId.has(incident.id)) byId.set(incident.id, incident);
    }
  }
  return [...byId.values()];
}

/**
 * The active (unresolved) guarantee breach for ONE cluster — the /frontiers
 * badge source. A rollback incident with a concrete target outranks a plain
 * alert (it changed what the cluster serves). null when the cluster is
 * clean (or the status endpoint had nothing to say).
 */
export function activeBreachForCluster(
  status: GuaranteeStatusDto | null,
  clusterId: string,
): IncidentDto | null {
  const active = collectIncidents(status).filter(
    (i) => i.resolvedAt === null && i.detail.clusterId === clusterId,
  );
  return (
    active.find((i) => i.kind === 'rollback' && typeof i.detail.toStrategy === 'string') ??
    active[0] ??
    null
  );
}

/** Badge label: rollback → "GUARANTEE BREACH — rolled back to <hash8>",
 * alert-only → "GUARANTEE ALERT". */
export function breachBadgeLabel(incident: IncidentDto): string {
  const to = incident.detail.toStrategy;
  if (incident.kind === 'rollback' && typeof to === 'string' && to.length > 0) {
    return `GUARANTEE BREACH — rolled back to ${to.slice(0, 8)}`;
  }
  return 'GUARANTEE ALERT';
}

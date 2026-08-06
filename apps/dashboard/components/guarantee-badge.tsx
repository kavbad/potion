// Amber guarantee-breach badge for /frontiers (M3 #22, SPEC §12.5) —
// rendered next to the provenance badges when the viewed cluster has an
// unresolved guarantee incident. Same badge language as the SIMULATED
// provenance badge (amber = caution).
import { breachBadgeLabel } from '@/lib/guarantee';
import type { IncidentDto } from '@/lib/types';

export function GuaranteeBadge({ incident }: { incident: IncidentDto }) {
  const rolling = incident.detail.rollingQuality;
  const min = incident.detail.minQuality;
  const title =
    typeof rolling === 'number' && typeof min === 'number'
      ? `rolling quality ${rolling.toFixed(2)} < guarantee floor ${min.toFixed(2)} (${
          incident.detail.windowMin ?? '?'
        }min window)`
      : 'quality guarantee breach';
  return (
    <span
      title={title}
      className="inline-block rounded-full border border-warn bg-amber-50 px-3 py-0.5 text-xs font-semibold tracking-wide text-warn"
    >
      {breachBadgeLabel(incident)}
    </span>
  );
}

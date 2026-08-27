// Guarantee incidents table (M3 #22, SPEC §12.5) — the /reports section:
// kind, cluster, rolling quality, time, and an admin-only resolve action
// (resolve lifts a rollback's operating-point override). Presentational;
// data comes from /api/guarantee/status via collectIncidents().
import { IncidentResolveButton } from '@/components/incident-resolve-button';
import type { IncidentDto } from '@/lib/types';

function KindBadge({ kind }: { kind: IncidentDto['kind'] }) {
  const cls =
    kind === 'rollback'
      ? 'border-warn bg-amber-50 text-warn'
      : 'border-line bg-paper text-soft';
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {kind === 'rollback' ? 'rollback' : 'alert'}
    </span>
  );
}

function short(hash: string | undefined): string {
  return hash && hash.length > 0 ? hash.slice(0, 8) : '—';
}

export function IncidentsTable({
  incidents,
  isAdmin,
}: {
  incidents: IncidentDto[];
  isAdmin: boolean;
}) {
  if (incidents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
        No guarantee incidents. Attach a{' '}
        <code className="font-mono">guarantee</code> block to a policy (
        <code className="font-mono">
          {'{ "minQuality": 0.8, "windowMin": 15, "sampleRate": 0.2, "action": "rollback", "minSamples": 20 }'}
        </code>
        ) and Potion watches the rolling quality of served answers — breaching the floor rolls
        the operating point back or raises an alert here.
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
          <th className="py-2 pr-4 font-medium">Kind</th>
          <th className="py-2 pr-4 font-medium">Cluster</th>
          <th className="py-2 pr-4 font-medium">Move</th>
          <th className="py-2 pr-4 text-right font-medium">Rolling quality</th>
          <th className="py-2 pr-4 font-medium">Time</th>
          <th className="py-2 text-right font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {incidents.map((i) => (
          <tr key={i.id} className="border-b border-line/60 last:border-0">
            <td className="py-2.5 pr-4">
              <KindBadge kind={i.kind} />
            </td>
            <td className="py-2.5 pr-4 font-mono text-xs text-ink">{i.detail.clusterId ?? '—'}</td>
            <td className="py-2.5 pr-4 font-mono text-[12px] text-soft">
              {i.kind === 'rollback' && typeof i.detail.toStrategy === 'string'
                ? `${short(i.detail.fromStrategy)} → ${short(i.detail.toStrategy)}`
                : '—'}
            </td>
            <td className="py-2.5 pr-4 text-right tabular-nums text-soft">
              {typeof i.detail.rollingQuality === 'number'
                ? i.detail.rollingQuality.toFixed(2)
                : '—'}
            </td>
            <td className="py-2.5 pr-4 text-xs text-faint">
              {new Date(i.createdAt).toLocaleString()}
            </td>
            <td className="py-2.5 text-right">
              {i.resolvedAt !== null ? (
                <span className="text-xs text-faint">
                  resolved {new Date(i.resolvedAt).toLocaleString()}
                </span>
              ) : isAdmin ? (
                <IncidentResolveButton id={i.id} />
              ) : (
                <span className="text-xs font-medium text-warn">open</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

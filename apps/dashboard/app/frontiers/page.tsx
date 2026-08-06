// /frontiers — the money shot. Server component: fetches the frontier list +
// the selected cluster's frontier from apps/server and SSRs the chart.
// Every point is badged by evidence provenance (M1a): SIMULATED (amber) when
// provider_mode is 'mock'/'unknown', LIVE (green) otherwise.
import Link from 'next/link';
import { FrontierChart } from '@/components/frontier-chart';
import { GuaranteeBadge } from '@/components/guarantee-badge';
import { SharePanel } from '@/components/share-panel';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { describeStrategy } from '@/lib/frontier-chart';
import { activeBreachForCluster } from '@/lib/guarantee';
import {
  clusterBadgeLabel,
  clusterProvenanceSummary,
  pointBadgeLabel,
} from '@/lib/provenance';
import type {
  FrontierListResponse,
  FrontierPointDto,
  FrontierResponse,
  GuaranteeStatusDto,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function FrontiersPage({
  searchParams,
}: {
  searchParams: Promise<{ cluster?: string }>;
}) {
  const { cluster } = await searchParams;

  let list: FrontierListResponse;
  try {
    list = await apiFetch<FrontierListResponse>('/api/frontiers');
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload — the demo data seeds itself on first boot.
          </div>
        </PageShell>
      );
    }
    throw e;
  }

  if (list.clusters.length === 0) {
    return (
      <PageShell>
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
          No frontiers yet. Frontiers are computed per workload cluster; the demo seed creates
          them for <span className="font-mono">code-gen</span> and{' '}
          <span className="font-mono">extraction</span> on first boot.
        </div>
      </PageShell>
    );
  }

  const selected = list.clusters.some((c) => c.clusterId === cluster)
    ? cluster!
    : list.clusters[0]!.clusterId;
  const selectedCluster = list.clusters.find((c) => c.clusterId === selected)!;
  const data = await apiFetch<FrontierResponse>(`/api/frontiers/${encodeURIComponent(selected)}`);

  // M3 #22 guarantee: an unresolved breach for the viewed cluster gets an
  // amber badge. Tolerant read — a guarantee-API hiccup must never take the
  // frontiers page down (null → no badge).
  const guaranteeStatus = await apiFetch<GuaranteeStatusDto>('/api/guarantee/status').catch(
    () => null,
  );
  const activeBreach = activeBreachForCluster(guaranteeStatus, selected);

  return (
    <PageShell>
      {/* cluster selector — plain links, no JS required */}
      <div className="mb-8 flex flex-wrap gap-2">
        {list.clusters.map((c) => (
          <Link
            key={c.clusterId}
            href={`/frontiers?cluster=${encodeURIComponent(c.clusterId)}`}
            className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
              c.clusterId === selected
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-line bg-panel text-soft hover:text-ink'
            }`}
          >
            {c.clusterId}
            <span className="ml-2 text-xs text-faint">v{c.version}</span>
          </Link>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-panel px-8 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">
            {selected} <span className="text-sm font-normal text-faint">— cost vs. quality</span>
          </h2>
          <span className="flex items-center gap-3">
            <span className="text-xs text-faint">
              frontier v{data.frontier.version} · prices {data.frontier.pricesVersion}
            </span>
            {/* M4 #31: mint a public read-only link to this cluster's
                frontier (token shown once; revocable) */}
            <SharePanel kind="frontier" clusterId={selected} />
          </span>
        </div>

        {/* provenance summary (M1a): the cluster's evidence status at a glance */}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <ClusterBadge label={clusterBadgeLabel(selectedCluster)} />
          <span className="text-xs text-soft">{clusterProvenanceSummary(selectedCluster)}</span>
          {/* guarantee breach badge (M3 #22): amber when an unresolved
              rollback/alert incident exists for this cluster */}
          {activeBreach ? <GuaranteeBadge incident={activeBreach} /> : null}
        </div>

        <FrontierChart data={data} />

        {/* per-point provenance badges (M1a): SIMULATED amber, LIVE green */}
        <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
          {data.frontier.points.map((p) => (
            <PointRow key={p.strategyHash} point={p} />
          ))}
        </ul>

        <p className="mt-6 text-sm text-soft">
          Only points on the line are worth paying for.
          {data.operatingPoint ? (
            <>
              {' '}
              Your current policy (
              <span className="font-mono text-xs">{data.operatingPoint.policy.type}</span>) runs{' '}
              {describeStrategy(data.operatingPoint.strategyConfig)}.
            </>
          ) : (
            <>
              {' '}
              Set a policy to see <span className="font-medium text-ink">you are here</span>.
            </>
          )}
        </p>
      </div>
    </PageShell>
  );
}

/** Amber badge for simulated evidence, green for live, mixed amber/green. */
function ClusterBadge({ label }: { label: 'SIMULATED' | 'LIVE' | 'MIXED' }) {
  const cls =
    label === 'LIVE'
      ? 'border-accent bg-accent-soft text-accent'
      : 'border-warn bg-amber-50 text-warn';
  return (
    <span
      className={`inline-block rounded-full border px-3 py-0.5 text-xs font-semibold tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function PointRow({ point }: { point: FrontierPointDto }) {
  const label = pointBadgeLabel(point.providerMode);
  const cls =
    label === 'LIVE'
      ? 'border-accent bg-accent-soft text-accent'
      : 'border-warn bg-amber-50 text-warn';
  return (
    <li className="flex items-center justify-between px-4 py-2">
      <span className="text-xs text-soft">{describeStrategy(point.strategyConfig)}</span>
      <span className="flex items-center gap-3">
        <span className="text-xs text-faint">
          {point.quality.toFixed(2)} · ${point.costPer1K.toFixed(3)}/1K
        </span>
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${cls}`}
        >
          {label}
        </span>
      </span>
    </li>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Frontiers</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Every dot is a strategy Potion measured on your kind of workload. Up and to the left is
        better: better answers for less money.
      </p>
      {children}
    </div>
  );
}

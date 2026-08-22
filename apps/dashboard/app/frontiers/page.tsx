// /frontiers — the money shot. Server component: fetches the frontier list +
// the selected cluster's frontier from apps/server and SSRs the chart.
// Every point is badged by evidence provenance (M1a): SIMULATED (amber) when
// provider_mode is 'mock'/'unknown', LIVE (green) otherwise.
import Link from 'next/link';
import { FrontierChart } from '@/components/frontier-chart';
import { GuaranteeBadge } from '@/components/guarantee-badge';
import { SharePanel } from '@/components/share-panel';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
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
  OperatingPointDto,
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
    list = await fetchOrRecover<FrontierListResponse>('/api/frontiers');
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
  const data = await fetchOrRecover<FrontierResponse>(`/api/frontiers/${encodeURIComponent(selected)}`);

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
              <LatencyNote op={data.operatingPoint} />
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

/**
 * The G2.6 latency story, in the owner's terms: a latency bound is a hard
 * constraint, so when it prunes the cheaper composition the customer is
 * paying a premium — and that premium is the product feature, not a footnote.
 * It is how a batch-tolerant customer discovers they should relax the bound.
 *
 * PROVISIONAL is the same discipline as the SIMULATED badge: a bound
 * evaluated against harness latency (a spread over benchmark items, on a
 * strategy-only span) has not been measured against served traffic, and
 * saying so is the difference between evidence and a claim.
 */
function LatencyNote({ op }: { op: OperatingPointDto }) {
  const ev = op.latencyEvidence;
  const premium = op.latencyPremium;
  const violation = op.latencyViolation;
  if (!ev && !premium && !violation) return null;
  return (
    <>
      {ev?.provisional ? (
        <>
          {' '}
          <span className="inline-block rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warn">
            PROVISIONAL
          </span>{' '}
          <span className="text-xs">
            the p95 above comes from benchmark runs, not your served traffic — it firms up once
            this cluster has enough requests.
          </span>
        </>
      ) : ev ? (
        <>
          {' '}
          <span className="text-xs">
            Latency measured on {ev.n} of your own served requests
            {ev.windowMin ? ` over the last ${ev.windowMin} minutes` : ''}.
          </span>
        </>
      ) : null}
      {violation ? (
        <>
          {' '}
          <span className="font-medium text-warn">
            Your {violation.boundMs}ms deadline cannot be met on this cluster.
          </span>{' '}
          We are serving the fastest strategy that still clears your quality floor (
          {Math.round(violation.servedP95Ms)}ms) rather than dropping quality to hit the clock
          {violation.relaxLatencyToMs !== null
            ? `; a ${Math.round(violation.relaxLatencyToMs)}ms deadline would be met`
            : ''}
          {violation.relaxQualityToFloor !== null
            ? `, or a ${violation.relaxQualityToFloor.toFixed(2)} quality floor would fit the current one`
            : ''}
          .
        </>
      ) : premium?.binding === 'latency' && premium.savingsPct > 0 ? (
        <>
          {' '}
          Your deadline is costing{' '}
          <span className="font-medium text-ink">
            {(premium.savingsPct * 100).toFixed(0)}%
          </span>
          : relaxing it to {Math.round(premium.relaxLatencyToMs ?? 0)}ms would serve the same
          quality floor for less.
        </>
      ) : null}
    </>
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

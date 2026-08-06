// /share/f/[token] (M4 #31, SPEC §13.3) — PUBLIC read-only shared frontier.
// No session: the `st_…` token IS the credential (sha256 at rest, revocable,
// uniform 404 — no existence oracle). Rendered server-side from
// GET /api/public/share/:token/frontier. Simulated points stay badged
// SIMULATED — a shared simulated frontier is never presented as live.
import { notFound } from 'next/navigation';
import { FrontierChart } from '@/components/frontier-chart';
import { apiUrl } from '@/lib/api';
import { describeStrategy } from '@/lib/frontier-chart';
import type { FrontierPointDto, FrontierResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PublicFrontierPayload {
  kind: 'frontier';
  clusterId: string;
  clusterName: string;
  frontier: FrontierResponse['frontier'];
  provenance: { live: number; simulated: number };
  redacted: boolean;
  sharedAt: string;
  organization: { id: string; name: string } | null;
}

async function loadPayload(token: string): Promise<PublicFrontierPayload | null> {
  try {
    const res = await fetch(
      `${apiUrl()}/api/public/share/${encodeURIComponent(token)}/frontier`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicFrontierPayload;
  } catch {
    return null;
  }
}

export default async function SharedFrontierPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const payload = await loadPayload(token);
  // Unknown/revoked/kind-mismatched tokens → a REAL 404 (status matters:
  // revoked links must stop resolving, and 200-with-apology would keep them
  // alive for crawlers/caches).
  if (!payload) notFound();

  const chartData: FrontierResponse = { frontier: payload.frontier, operatingPoint: null };
  const allSimulated = payload.provenance.live === 0;

  return (
    <div className="max-w-4xl">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
        Shared read-only · Potion
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">
        {payload.clusterName}{' '}
        <span className="text-base font-normal text-faint">— cost vs. quality frontier</span>
      </h1>
      <p className="mb-8 mt-2 text-sm text-soft">
        {payload.organization ? (
          <>
            Shared by <span className="font-medium text-ink">{payload.organization.name}</span> ·{' '}
          </>
        ) : null}
        frontier v{payload.frontier.version} · shared{' '}
        {new Date(payload.sharedAt).toLocaleDateString()}
      </p>

      {allSimulated ? (
        <div className="mb-6 rounded-lg border border-warn bg-amber-50 px-4 py-3 text-sm text-warn">
          Every point on this frontier is backed by SIMULATED evidence, not live provider runs.
        </div>
      ) : payload.provenance.simulated > 0 ? (
        <div className="mb-6 rounded-lg border border-warn bg-amber-50 px-4 py-3 text-sm text-warn">
          {payload.provenance.simulated} of{' '}
          {payload.provenance.live + payload.provenance.simulated} points are SIMULATED; the rest
          are live-verified.
        </div>
      ) : null}

      <div className="rounded-xl border border-line bg-panel px-8 py-8">
        <FrontierChart data={chartData} />
        <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
          {payload.frontier.points.map((p: FrontierPointDto) => {
            const simulated = p.providerMode !== 'live';
            return (
              <li key={p.strategyHash} className="flex items-center justify-between px-4 py-2">
                <span className="text-xs text-soft">{describeStrategy(p.strategyConfig)}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-faint">
                    {p.quality.toFixed(2)} · ${p.costPer1K.toFixed(3)}/1K
                  </span>
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
                      simulated
                        ? 'border-warn bg-amber-50 text-warn'
                        : 'border-accent bg-accent-soft text-accent'
                    }`}
                  >
                    {simulated ? 'SIMULATED' : 'LIVE'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-6 text-xs text-faint">
          Read-only snapshot served by Potion. The owner can revoke this link at any time.
        </p>
      </div>
    </div>
  );
}

// /playground (M4 #31, SPEC §13.3). Server component: fetches the frontier
// list + the selected cluster's frontier, then hands off to the client
// Playground (SSE chat + compare). Empty states mirror the frontiers page.
import { Playground } from '@/components/playground';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import type { FrontierListResponse, FrontierResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function PlaygroundPage({
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
          No frontiers yet — nothing to play with. Frontiers are computed per workload cluster;
          the demo seed creates them on first boot.
        </div>
      </PageShell>
    );
  }

  const selected = list.clusters.some((c) => c.clusterId === cluster)
    ? cluster!
    : list.clusters[0]!.clusterId;
  const data = await apiFetch<FrontierResponse>(
    `/api/frontiers/${encodeURIComponent(selected)}`,
  );

  return (
    <PageShell>
      <Playground
        clusters={list.clusters.map((c) => ({ clusterId: c.clusterId, version: c.version }))}
        selected={selected}
        frontier={data}
      />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Talk to any point on the frontier — or let your policy route with potion-auto. Compare two
        points side by side: same conversation, different cost and quality.
      </p>
      {children}
    </div>
  );
}

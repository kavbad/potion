// /leaderboard (M4b #32, SPEC §13.4) — PUBLIC: the recipe library's public
// face. Lists only frontier recipes with LIVE-provenance evidence at/above
// the quality bar; every entry carries the verification run a skeptic can
// re-run. Pre-M1b there IS no live evidence, so the page renders an honest
// "awaiting live verification" state — simulated numbers are never
// substituted. Session-free (middleware open prefix); fetched server-side
// from GET /api/leaderboard (itself auth-exempt on the API).
import { apiUrl } from '@/lib/api';
import type { LeaderboardResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function loadLeaderboard(): Promise<LeaderboardResponse | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/leaderboard`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as LeaderboardResponse;
  } catch {
    return null;
  }
}

export default async function LeaderboardPage() {
  const data = await loadLeaderboard();

  return (
    <div className="max-w-4xl">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
        Public · live-verified only · Potion
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Recipe leaderboard</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Model-combination recipes that Potion&apos;s researcher discovered and{' '}
        <span className="font-medium text-ink">proved against real providers</span>. Every entry
        links the verification run — nothing here is simulated.
      </p>

      {data === null ? (
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
          The leaderboard is temporarily unavailable.
        </div>
      ) : data.status === 'awaiting_live_verification' ? (
        <div className="rounded-lg border border-warn bg-amber-50 p-6">
          <div className="text-sm font-medium text-ink">Awaiting live verification</div>
          <p className="mt-1 text-sm leading-relaxed text-soft">{data.message}</p>
          <p className="mt-3 text-xs text-faint">
            The researcher is already generating and evaluating recipes against simulated
            providers; entries appear here once live evaluation runs complete.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-paper text-xs text-faint">
                <th className="px-4 py-2 font-medium">Cluster</th>
                <th className="px-4 py-2 font-medium">Recipe</th>
                <th className="px-4 py-2 text-right font-medium">Quality</th>
                <th className="px-4 py-2 text-right font-medium">Cost /1K</th>
                <th className="px-4 py-2 font-medium">Verification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.entries.map((e) => (
                <tr key={`${e.clusterId}:${e.strategyHash}`}>
                  <td className="px-4 py-2.5 font-mono text-xs text-soft">{e.clusterName}</td>
                  <td className="px-4 py-2.5 text-xs text-ink">{e.strategyLabel}</td>
                  <td className="px-4 py-2.5 text-right text-xs font-medium text-ink">
                    {e.quality.toFixed(3)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-soft">
                    ${e.costPer1K.toFixed(3)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-faint">
                    {e.verificationRunId !== null ? (
                      <span className="font-mono">
                        {e.verificationRunId}
                        {e.verifiedAt !== null
                          ? ` · ${new Date(e.verifiedAt).toISOString().slice(0, 10)}`
                          : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                    <span className="ml-2 rounded-full border border-accent bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      v{e.frontierVersion}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data !== null && data.adoptingOrgs.length > 0 ? (
        <p className="mt-6 text-xs text-faint">
          Organizations evaluating Potion recipes in production: {data.adoptingOrgs.join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

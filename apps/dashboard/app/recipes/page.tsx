// /recipes (M4b #37, SPEC §15) — the recipe library: the autoresearcher's
// accumulated asset. Every strategy Potion has generated and evaluated,
// content-addressed by hash, compounding with every model launch. Status
// lifecycle: candidate → frontier (promoted by the paired-bootstrap gate) →
// archived. Provenance badging follows M1a: only all-live evidence badges
// LIVE; mock/mixed/unknown badge SIMULATED.
import { RecipeEvaluateButton, ResearchScanButton } from '@/components/recipe-actions';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import type {
  RecipeDto,
  RecipeProvenance,
  RecipesResponse,
  RecipeStatus,
  ResearchCyclesResponse,
} from '@/lib/types';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const STATUS_FILTERS: Array<{ value: RecipeStatus | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'frontier', label: 'Frontier' },
  { value: 'candidate', label: 'Candidates' },
  { value: 'archived', label: 'Archived' },
];

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const activeStatus = STATUS_FILTERS.some((f) => f.value === status)
    ? (status as RecipeStatus)
    : undefined;

  let data: RecipesResponse;
  try {
    data = await fetchOrRecover<RecipesResponse>(
      `/api/recipes${activeStatus !== undefined ? `?status=${activeStatus}` : ''}`,
    );
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload.
          </div>
        </PageShell>
      );
    }
    throw e;
  }
  // Tolerant reads — the cycles strip and the admin buttons must never take
  // the library down.
  const cycles = await apiFetch<ResearchCyclesResponse>('/api/research/cycles').catch(() => null);
  const me = await apiFetch<MeResponse>('/api/auth/me').catch(() => null);
  const isAdmin = me?.role === 'admin';

  return (
    <PageShell>
      {/* research strip: scan trigger (admin) + recent cycles */}
      <div className="mb-6 rounded-lg border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-soft">
            <span className="font-medium text-ink">Autoresearcher.</span> Scans the model catalog
            for new models, generates candidate recipes, evaluates them against the held-out
            suites, and promotes only what the bootstrap gate proves better.
          </div>
          {isAdmin ? <ResearchScanButton /> : null}
        </div>
        {cycles && cycles.cycles.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {cycles.cycles.slice(0, 5).map((c) => (
              <li key={c.id} className="flex items-center justify-between py-1.5 text-xs">
                <span className="text-soft">
                  <span className="font-mono text-faint">{c.trigger}</span>
                  {c.focusAlias ? (
                    <>
                      {' '}
                      · focus <span className="font-mono">{c.focusAlias}</span>
                    </>
                  ) : null}{' '}
                  · {c.candidates} candidate{c.candidates === 1 ? '' : 's'}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-faint">
                    {c.status} · ${c.spendUsd.toFixed(4)}
                  </span>
                  <ProvenanceBadge provenance={c.provenance === 'live' ? 'live' : 'mock'} />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* status filter — plain links, no JS required */}
      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = f.value === activeStatus;
          return (
            <Link
              key={f.label}
              href={f.value === undefined ? '/recipes' : `/recipes?status=${f.value}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-paper text-soft hover:text-ink'
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {data.recipes.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
          No recipes yet{activeStatus !== undefined ? ` with status ${activeStatus}` : ''}. The
          library fills in when a research cycle runs — trigger a scan (admin) or wait for the
          nightly scan.
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
          {data.recipes.map((r) => (
            <RecipeRow key={r.hash} recipe={r} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </PageShell>
  );
}

function RecipeRow({ recipe, isAdmin }: { recipe: RecipeDto; isAdmin: boolean }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium text-ink">{recipe.label}</span>{' '}
          <span className="font-mono text-[10px] text-faint">{recipe.hash.slice(0, 12)}…</span>
        </div>
        <span className="flex items-center gap-2">
          <span className="text-xs text-faint">
            {recipe.lineage.evalCount} eval{recipe.lineage.evalCount === 1 ? '' : 's'}
          </span>
          <StatusBadge status={recipe.status} />
          <ProvenanceBadge provenance={recipe.provenance} />
          {isAdmin ? <RecipeEvaluateButton hash={recipe.hash} /> : null}
        </span>
      </div>
      {/* lineage drawer — no JS required */}
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs text-faint hover:text-soft">
          lineage · {recipe.lineage.clusters.join(', ') || 'no evals yet'}
        </summary>
        <div className="mt-2 space-y-1 rounded-md bg-paper p-3 text-xs text-soft">
          <div>
            clusters:{' '}
            {recipe.lineage.clusters.length > 0 ? recipe.lineage.clusters.join(', ') : '—'}
          </div>
          <div>
            runs:{' '}
            {recipe.lineage.runIds.length > 0 ? (
              <span className="font-mono">{recipe.lineage.runIds.join(', ')}</span>
            ) : (
              '—'
            )}
          </div>
          <div>
            first seen {fmtDate(recipe.lineage.firstSeen)} · last seen{' '}
            {fmtDate(recipe.lineage.lastSeen)} · registered {fmtDate(recipe.registeredAt)}
          </div>
          {recipe.lineage.cycles.length > 0 ? (
            <div>
              cycles:{' '}
              {recipe.lineage.cycles.map((c) => (
                <span key={c.id} className="mr-2 font-mono">
                  {c.trigger}
                  {c.focusAlias ? `(${c.focusAlias})` : ''} {fmtDate(c.createdAt)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** candidate = neutral outline, frontier = accent (promoted), archived = faint. */
function StatusBadge({ status }: { status: RecipeStatus }) {
  const cls =
    status === 'frontier'
      ? 'border-accent bg-accent-soft text-accent'
      : status === 'candidate'
        ? 'border-line bg-paper text-soft'
        : 'border-line bg-panel text-faint';
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

/** M1a convention: only all-live evidence badges LIVE; everything else amber. */
function ProvenanceBadge({ provenance }: { provenance: RecipeProvenance }) {
  const live = provenance === 'live';
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
        live ? 'border-accent bg-accent-soft text-accent' : 'border-warn bg-amber-50 text-warn'
      }`}
    >
      {live ? 'LIVE' : 'SIMULATED'}
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Recipe library</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Every strategy the researcher has generated and measured, content-addressed and kept.
        Promoted recipes serve traffic; the rest stay as evidence that compounds with every model
        launch.
      </p>
      {children}
    </div>
  );
}

// /rubrics (G1.5) — the customer-visible rubric review surface.
//
// OWNER RULE (load-bearing): customers see EVERYTHING derived from their
// data, always paired with its status and evidence. Only an APPROVED rubric
// is IN FORCE; drafts, rejections, and superseded rubrics render with
// unmistakable NOT-IN-FORCE badges, their full text, their probe-calibration
// verdict (or the uncalibrated reason), and — for rejections — the failure
// reason. Nothing is ever hidden: "this rubric failed calibration at r=0.6
// and was not deployed" is the visible rigor the guarantee sells.
import { CertifyButton, RubricGenerateButton, RubricReviewButtons } from '@/components/rubric-actions';
import { certificationBadge } from '@/lib/cert-badge';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import type { FrontierListResponse } from '@/lib/types';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

interface RubricCalibration {
  pearsonVsTruth: number | null;
  spearmanVsTruth: number | null;
  meanAbsErr: number | null;
  flagged: boolean;
  n: number;
  providerMode: string;
}

interface RubricRow {
  id: string;
  clusterId: string;
  suiteId: string;
  rubricText: string;
  rubricHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  inForce: boolean;
  statusReason: string | null;
  generatorModel: string;
  providerMode: string;
  exemplarCount: number;
  spendUsd: number;
  createdAt: string;
  calibration: RubricCalibration | null;
}

interface RubricsResponse {
  rubrics: RubricRow[];
}

interface CertificationRow {
  id: string;
  clusterId: string;
  suiteId: string;
  suiteVersion: string;
  status: 'pending' | 'certified' | 'failed' | 'superseded';
  /** THE GATE's answer, not a row-status boolean (F11). */
  active: boolean;
  /** Set when a passing measurement no longer vouches: the suite moved. */
  staleReason: string | null;
  currentSuiteId: string | null;
  currentSuiteVersion: string | null;
  refused: boolean;
  statusReason: string | null;
  selfRetentionMean: number | null;
  floor: number | null;
  items: number | null;
  providerMode: string;
  spendUsd: number;
  createdAt: string;
}

const STATUS_BADGE: Record<RubricRow['status'], { label: string; cls: string }> = {
  approved: { label: 'IN FORCE', cls: 'bg-accent/15 text-accent' },
  pending: { label: 'DRAFT — NOT IN FORCE', cls: 'bg-warn/15 text-warn' },
  rejected: { label: 'REJECTED — NOT IN FORCE', cls: 'bg-line text-faint' },
  superseded: { label: 'SUPERSEDED — NOT IN FORCE', cls: 'bg-line text-faint' },
};

function fmt(x: number | null): string {
  return x === null ? '—' : x.toFixed(3);
}

export default async function RubricsPage() {
  let data: RubricsResponse;
  try {
    data = await fetchOrRecover<RubricsResponse>('/api/rubrics');
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload.
          </div>
        </PageShell>
      );
    }
    throw e;
  }
  const me = await apiFetch<MeResponse>('/api/auth/me').catch(() => null);
  const isAdmin = me?.role === 'admin';
  const frontiers = await apiFetch<FrontierListResponse>('/api/frontiers').catch(() => null);
  const agentClusters = (frontiers?.clusters ?? []).filter((c) => c.clusterId.startsWith('agent-'));
  const withRubric = new Set(data.rubrics.map((r) => r.clusterId));
  const certs = await apiFetch<{ certifications: CertificationRow[] }>('/api/certifications').catch(
    () => null,
  );

  return (
    <PageShell>
      {isAdmin && agentClusters.length > 0 ? (
        <div className="mb-6 border border-[#d9d5cb] bg-[#fbfaf7] p-4">
          <div className="text-sm font-medium text-ink">Generate a rubric</div>
          <p className="mt-1 text-xs text-soft">
            One capped, metered LLM call over the cluster&apos;s redacted exemplars produces a
            DRAFT — probe-calibrated against your sessions&apos; original answers, and never in
            force until you approve it here.
          </p>
          <ul className="mt-2 space-y-1">
            {agentClusters.map((c) => (
              <li key={c.clusterId} className="flex items-center justify-between gap-3 text-xs">
                <span className="font-mono text-soft">{c.clusterId}</span>
                <span className="flex items-center gap-2">
                  {withRubric.has(c.clusterId) ? (
                    <span className="text-faint">has rubric rows below</span>
                  ) : null}
                  <RubricGenerateButton clusterId={c.clusterId} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Suite certifications (Decision 2) — same review surface as rubrics:
          every attempt visible with status + evidence. An uncertified suite
          may be inspected but backs NO contractual claim. */}
      <div className="mb-6 border border-[#d9d5cb] bg-[#fbfaf7] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-ink">Suite certifications</div>
        </div>
        <p className="mt-1 text-xs text-soft">
          A suite is certified when your designated incumbent retains its own baseline
          (self-retention ≥ floor) on a fresh re-evaluation. Uncertified suites render no
          retention numbers and open no incidents — verdicts are still measured and kept.
        </p>
        {isAdmin && agentClusters.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {agentClusters.map((c) => (
              <li key={c.clusterId} className="flex items-center justify-between gap-3 text-xs">
                <span className="font-mono text-soft">{c.clusterId}</span>
                <CertifyButton clusterId={c.clusterId} />
              </li>
            ))}
          </ul>
        ) : null}
        {(certs?.certifications ?? []).length > 0 ? (
          <ul className="mt-3 space-y-2 border-t border-line pt-3">
            {certs!.certifications.map((c) => {
              const badge = certificationBadge(c);
              return (
                <li key={c.id} className="text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-soft">
                      {c.suiteId} <span className="text-faint">v{c.suiteVersion}</span>
                    </span>
                    <span className={`rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-0.5 text-faint">
                    {c.selfRetentionMean !== null
                      ? `self-retention ${c.selfRetentionMean.toFixed(4)} vs floor ${c.floor ?? '—'} over ${c.items ?? '—'} items · `
                      : ''}
                    {c.providerMode} · ${c.spendUsd.toFixed(4)}
                    {c.statusReason ? ` · ${c.statusReason}` : ''}
                    {c.staleReason ? ` · ${c.staleReason}` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-faint">No certification attempts yet.</p>
        )}
      </div>

      {data.rubrics.length === 0 ? (
        <div className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
          No rubrics yet. Rubrics are generated per agent cluster from your traced sessions
          {isAdmin ? ' — use the generator above once clustering has run.' : '.'}
        </div>
      ) : (
        <ul className="space-y-4">
          {data.rubrics.map((r) => {
            const badge = STATUS_BADGE[r.status];
            return (
              <li key={r.id} className="border border-[#d9d5cb] bg-[#fbfaf7] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-soft">{r.clusterId}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                </div>

                {/* the rubric text — always shown, whatever the status */}
                <p className="mt-3 whitespace-pre-wrap rounded-md border border-line bg-paper p-3 text-sm leading-relaxed text-ink">
                  {r.rubricText}
                </p>

                {/* evidence line: calibration verdict or the uncalibrated reason */}
                <div className="mt-3 text-xs text-soft">
                  {r.calibration !== null ? (
                    <>
                      <span className="font-medium text-ink">Probe calibration</span>{' '}
                      (synthetic-perturbation truth, {r.calibration.providerMode}): r={' '}
                      {fmt(r.calibration.pearsonVsTruth)} · ρ = {fmt(r.calibration.spearmanVsTruth)}{' '}
                      · mAE = {fmt(r.calibration.meanAbsErr)} (advisory) · n = {r.calibration.n} ·{' '}
                      {r.calibration.flagged ? (
                        <span className="text-warn">FLAGGED below the 0.8 trust line</span>
                      ) : (
                        <span className="text-accent">clears the 0.8 trust line</span>
                      )}
                    </>
                  ) : (
                    <span className="text-warn">
                      Uncalibrated{r.statusReason !== null && r.status === 'pending' ? ` — ${r.statusReason}` : ''}
                    </span>
                  )}
                </div>

                {/* status reason (rejections/supersessions stay visible WITH the why) */}
                {r.statusReason !== null && !(r.calibration === null && r.status === 'pending') ? (
                  <div className="mt-1 text-xs text-faint">Reason: {r.statusReason}</div>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
                  <span>
                    generated by <span className="font-mono">{r.generatorModel}</span> (
                    {r.providerMode}) from {r.exemplarCount} exemplar
                    {r.exemplarCount === 1 ? '' : 's'} · ${r.spendUsd.toFixed(4)} ·{' '}
                    <Link
                      href={`/frontiers?cluster=${encodeURIComponent(r.clusterId)}`}
                      className="text-accent hover:underline"
                    >
                      frontier
                    </Link>
                  </span>
                  <span className="font-mono">{r.rubricHash.slice(0, 12)}</span>
                </div>

                {isAdmin && r.status === 'pending' ? (
                  <div className="mt-3 border-t border-line pt-3">
                    <RubricReviewButtons id={r.id} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Rubrics</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        How your agent clusters are graded. Every rubric derived from your data appears here with
        its lifecycle status and calibration evidence — drafts and rejections included. Only an
        approved rubric is in force.
      </p>
      {children}
    </div>
  );
}

// /share/r/[token] (M4 #31, SPEC §13.3) — PUBLIC read-only shared savings
// report. No session: the `st_…` token IS the credential (sha256 at rest,
// revocable, uniform 404). Rendered server-side from
// GET /api/public/share/:token/report. When the owner redacted names the
// org id arrives stripped and no organization block is present.
import { notFound } from 'next/navigation';
import { SavingsChart } from '@/components/savings-chart';
import { apiUrl } from '@/lib/api';
import { confidenceHint } from '@/lib/savings-chart';
import { formatUsd } from '@/lib/usage-chart';
import type { SavingsAlternativeDto, SavingsReportDto } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PublicReportPayload {
  kind: 'report';
  windowDays: number;
  from: string;
  to: string;
  report: SavingsReportDto;
  redacted: boolean;
  sharedAt: string;
  organization: { id: string; name: string } | null;
}

async function loadPayload(token: string): Promise<PublicReportPayload | null> {
  try {
    const res = await fetch(
      `${apiUrl()}/api/public/share/${encodeURIComponent(token)}/report`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicReportPayload;
  } catch {
    return null;
  }
}

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const payload = await loadPayload(token);
  // Unknown/revoked tokens → a REAL 404 (see the frontier share page).
  if (!payload) notFound();

  const { report } = payload;
  const best = report.alternatives[0] ?? null;
  const bestSaving = best !== null && best.deltaUsd > 0 ? best : null;

  return (
    <div className="max-w-4xl">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
        Shared read-only · Potion
      </div>
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Savings report</h1>
      <p className="mb-8 mt-2 text-sm text-soft">
        {payload.organization ? (
          <>
            Shared by <span className="font-medium text-ink">{payload.organization.name}</span> ·{' '}
          </>
        ) : null}
        {payload.from} → {payload.to} · shared {new Date(payload.sharedAt).toLocaleDateString()}
      </p>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="Actual spend" value={formatUsd(report.actualSpendUsd)} />
        <StatCard label="Shadowed alternatives" value={String(report.alternatives.length)} />
        <StatCard
          label="Best projected saving"
          value={bestSaving ? `${formatUsd(bestSaving.deltaUsd)} · ${bestSaving.label}` : '—'}
        />
      </div>

      <section className="mb-8 border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">Actual vs. projected spend</h2>
          <span className="text-xs text-faint">
            {payload.from} → {payload.to}
          </span>
        </div>
        <SavingsChart report={report} />
      </section>

      <section className="border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        <h2 className="mb-6 text-lg font-medium text-ink">Shadowed alternatives</h2>
        {report.alternatives.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
            Nothing shadowed in this window.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                <th className="py-2 pr-4 font-medium">Alternative</th>
                <th className="py-2 pr-4 text-right font-medium">Projected spend</th>
                <th className="py-2 pr-4 text-right font-medium">Quality</th>
                <th className="py-2 pr-4 text-right font-medium">Δ vs actual</th>
                <th className="py-2 pr-4 text-right font-medium">Samples</th>
                <th className="py-2 text-right font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {report.alternatives.map((a: SavingsAlternativeDto) => (
                <tr key={a.strategyHash} className="border-b border-line last:border-0">
                  <td className="py-2 pr-4 text-soft">{a.label}</td>
                  <td className="py-2 pr-4 text-right text-ink">
                    {formatUsd(a.projectedSpendUsd)}
                  </td>
                  <td className="py-2 pr-4 text-right text-ink">
                    {a.projectedQuality.toFixed(2)}
                  </td>
                  <td
                    className={`py-2 pr-4 text-right ${a.deltaUsd > 0 ? 'text-accent' : 'text-warn'}`}
                  >
                    {a.deltaUsd > 0 ? `−${formatUsd(a.deltaUsd)}` : `+${formatUsd(-a.deltaUsd)}`}
                  </td>
                  <td className="py-2 pr-4 text-right text-faint">{a.sampleSize}</td>
                  <td className="py-2 text-right text-faint">{confidenceHint(a.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-6 text-xs leading-relaxed text-faint">
          Shadow mode replays a sample of traffic against candidate strategies — projections scale
          each candidate&apos;s measured mean cost to the whole window. Read-only snapshot served
          by Potion; the owner can revoke this link at any time.
        </p>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-1 truncate text-lg font-medium text-ink">{value}</div>
    </div>
  );
}

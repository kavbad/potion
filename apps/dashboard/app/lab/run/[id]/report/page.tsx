// /lab/run/[id]/report (Step 8) — report v1: what happened, what it cost
// (est vs metered LABELED, never blended), where it struggled (typed
// evidence), and exactly ONE evidence-chosen upgrade. No model advice in v1.
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { SimulatedBadge } from '@/components/lab-actions';

export const dynamic = 'force-dynamic';

interface StepCostRow {
  seq: number;
  kind: string;
  slot?: 'brain' | 'tools';
  excerpt: string;
  meteredUsd: number | null;
  estimatedUsd: number | null;
}

type Struggle = { code: string } & Record<string, unknown>;

interface ReportDto {
  runId: string;
  outcome: string;
  outcomeDetail: string | null;
  missionGoal: string;
  summary: string;
  steps: StepCostRow[];
  meteredTotalUsd: number;
  estimatedUnmeteredUsd: number;
  fuelCapUsd: number;
  struggles: Struggle[];
  suggestedUpgrade: { reason: string; text: string };
  provenances: string[];
  simulated: boolean;
}

function struggleDetail(s: Struggle): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === 'code') continue;
    parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  }
  return parts.join(' · ');
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await apiFetch<ReportDto>(`/api/lab/runs/${id}/report`);
  return (
    <main style={{ padding: 16 }}>
      <p>
        <Link href={`/lab/run/${id}`}>← Run</Link>
      </p>
      <h1>
        Trial report <SimulatedBadge simulated={r.simulated} />
      </h1>

      <section data-testid="report-what-happened">
        <h3>1. What happened</h3>
        <p>Mission: {r.missionGoal}</p>
        <p>
          Outcome: <b>{r.outcome}</b>
          {r.outcomeDetail ? ` (${r.outcomeDetail})` : ''}
        </p>
        {r.summary ? <blockquote data-testid="report-summary">{r.summary}</blockquote> : null}
      </section>

      <section data-testid="report-cost">
        <h3>2. What it cost</h3>
        <p>
          <b>${r.meteredTotalUsd.toFixed(4)}</b> metered
          {r.estimatedUnmeteredUsd > 0 ? (
            <span>
              {' '}
              + ${r.estimatedUnmeteredUsd.toFixed(4)} <i>est.</i> (unresolved)
            </span>
          ) : null}{' '}
          of a ${r.fuelCapUsd} fuel cap
        </p>
        <table border={1} cellPadding={4}>
          <thead>
            <tr>
              <th>step</th>
              <th>kind</th>
              <th>slot</th>
              <th>metered $</th>
              <th>est. $</th>
            </tr>
          </thead>
          <tbody>
            {r.steps.map((s) => (
              <tr key={s.seq}>
                <td>{s.seq}</td>
                <td>{s.kind}</td>
                <td>{s.slot ?? ''}</td>
                <td>{s.meteredUsd !== null ? s.meteredUsd.toFixed(4) : '—'}</td>
                <td>{s.meteredUsd === null && s.estimatedUsd !== null ? s.estimatedUsd.toFixed(4) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-testid="report-struggles">
        <h3>3. Where it struggled</h3>
        {r.struggles.length === 0 ? <p>No recorded struggles.</p> : null}
        <ul>
          {r.struggles.map((s, i) => (
            <li key={i}>
              <code>{s.code}</code>
              {struggleDetail(s) ? ` — ${struggleDetail(s)}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="report-upgrade">
        <h3>4. The one upgrade</h3>
        <p>
          <code>{r.suggestedUpgrade.reason}</code> — {r.suggestedUpgrade.text}
        </p>
      </section>
    </main>
  );
}

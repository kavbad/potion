// /lab/harness/[hash] (Step 8) — spec summary, provenance sidecar, typed
// superpower posture (not-connected until Step 10), dial views, trial start.
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { NotConnectedBadge, StartTrialButton } from '@/components/lab-actions';

export const dynamic = 'force-dynamic';

interface DialViewDto {
  feasible: boolean;
  position: { qualityIndex: number; toleranceMs?: number };
  quality?: number;
  costPer1K?: number;
  latencyP95?: number;
  strategyType?: string;
  gap?: { code: string; relaxHintMs?: number };
}

interface HarnessDetail {
  harnessHash: string;
  name: string;
  clusterId: string;
  spec: {
    mission: { kind: string; goal: string; doneDefinition?: string };
    fuel: { maxUsdPerRun: number; hardStop: boolean };
    rules: string[];
  } | null;
  sidecar: { specHash: string; choices: Array<{ slot: string; basis: { clusterId: string; frontierId: string; providerMode: string } }> };
  superpowers: Array<{ id: string; scopes: string[]; status: 'not-connected' }>;
  dial: {
    brain: { ok: boolean; views?: DialViewDto[]; gap?: { code: string } };
    tools?: { ok: boolean; views?: DialViewDto[]; gap?: { code: string } };
  };
}

export default async function HarnessPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const h = await apiFetch<HarnessDetail>(`/api/lab/harnesses/${hash}`);
  return (
    <main style={{ padding: 16 }}>
      <p>
        <Link href="/lab">← Lab</Link>
      </p>
      <h1 data-testid="harness-name">{h.name}</h1>
      <p>
        Cluster <code>{h.clusterId}</code> · spec <code>{h.harnessHash.slice(0, 12)}…</code>
      </p>
      {h.spec ? (
        <section data-testid="spec-summary">
          <h3>Mission ({h.spec.mission.kind})</h3>
          <p>{h.spec.mission.goal}</p>
          {h.spec.mission.doneDefinition ? <p>Done when: {h.spec.mission.doneDefinition}</p> : null}
          <p>
            Fuel: ${h.spec.fuel.maxUsdPerRun} per run{h.spec.fuel.hardStop ? ' (hard stop)' : ''}
          </p>
          {h.spec.rules.length > 0 ? <p>Rules: {h.spec.rules.join(' · ')}</p> : null}
        </section>
      ) : (
        <p>Spec no longer parses — the catalog row is stale.</p>
      )}
      <section data-testid="harness-posture">
        <h3>Superpowers</h3>
        {h.superpowers.length === 0 ? <p>None declared.</p> : null}
        <ul>
          {h.superpowers.map((s) => (
            <li key={s.id}>
              {s.id} <NotConnectedBadge />{' '}
              <small>(declared; connects in a later step — trials run brain-only)</small>
            </li>
          ))}
        </ul>
      </section>
      <section data-testid="dial-views">
        <h3>The dial</h3>
        {h.dial.brain.ok && h.dial.brain.views ? (
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>rung</th>
                <th>quality</th>
                <th>$/1K</th>
                <th>p95 ms</th>
                <th>type</th>
              </tr>
            </thead>
            <tbody>
              {h.dial.brain.views.map((v, i) => (
                <tr key={i}>
                  <td>{v.position.qualityIndex}</td>
                  {v.feasible ? (
                    <>
                      <td>{v.quality}</td>
                      <td>{v.costPer1K}</td>
                      <td>{v.latencyP95}</td>
                      <td>{v.strategyType}</td>
                    </>
                  ) : (
                    <td colSpan={4}>
                      infeasible: {v.gap?.code}
                      {v.gap?.relaxHintMs !== undefined ? ` (relax to ≥${v.gap.relaxHintMs}ms)` : ''}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p data-testid="dial-gap">Dial unavailable: {h.dial.brain.gap?.code}</p>
        )}
      </section>
      <p style={{ marginTop: 12 }}>
        <StartTrialButton harnessHash={h.harnessHash} />{' '}
        <Link href={`/lab/memory/${h.harnessHash}`}>Memory →</Link>
      </p>
    </main>
  );
}

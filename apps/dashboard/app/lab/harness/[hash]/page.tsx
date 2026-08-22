// /lab/harness/[hash] (Step 9) — THE DERIVED FORM is the page. No template
// UI remains as the primary surface: spec, dial, posture, and memory are
// the form's own anatomy, edited through its mid-zoom panels over the real
// routes. The old tables live on inside those panels' plain language.
import Link from 'next/link';
import { fetchOrRecover } from '@/lib/recover';
import { LabFormView } from '@/components/lab-form-view';
import { ConnectorPanel } from '@/components/lab-actions';
import type { HarnessDto, MemoryDto } from '@potion/lab-form';

export const dynamic = 'force-dynamic';

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

interface RunsResponse {
  runs: Array<{ runId: string; state: string }>;
}

export default async function HarnessPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const [harness, memory, runs, me] = await Promise.all([
    fetchOrRecover<HarnessDto>(`/api/lab/harnesses/${hash}`),
    fetchOrRecover<MemoryDto>(`/api/lab/memory/${hash}`),
    fetchOrRecover<RunsResponse>(`/api/lab/harnesses/${hash}/runs`),
    fetchOrRecover<MeResponse>('/auth/me'),
  ]);
  const latest = runs.runs[0] ?? null;
  return (
    <main style={{ padding: 16 }}>
      <p>
        <Link href="/lab">← Lab</Link>{' '}
        <span style={{ color: '#6b7688', fontSize: 12 }}>
          {harness.name} · <code>{harness.harnessHash.slice(0, 12)}…</code> · {harness.clusterId}
        </span>
      </p>
      {harness.spec === null ? (
        <p>
          This catalog row&apos;s spec no longer parses — the form cannot derive
          from it. The row is preserved; re-generate or edit from a valid row.
        </p>
      ) : (
        <LabFormView
          harness={harness}
          memory={memory}
          runId={latest?.runId ?? null}
          role={me.role}
          surface="harness"
        />
      )}
      {/* Step 10: the filament's control surface — connect heals, revoke cuts. */}
      {harness.spec !== null && harness.spec.superpowers.length > 0 ? <ConnectorPanel /> : null}
    </main>
  );
}

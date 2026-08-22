// /lab/run/[id] (Step 9) — the run seen THROUGH the derived form: the same
// poll, rendered as the organism's own luminosity. The narration timeline
// remains available via the report; the answer/kill/report controls ride
// the form's overlay through the same real routes as Step 8.
import Link from 'next/link';
import { fetchOrRecover } from '@/lib/recover';
import { LabFormView } from '@/components/lab-form-view';
import type { HarnessDto, MemoryDto, RunDto } from '@potion/lab-form';

export const dynamic = 'force-dynamic';

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await fetchOrRecover<RunDto>(`/api/lab/runs/${id}`);
  const [harness, memory, me] = await Promise.all([
    fetchOrRecover<HarnessDto>(`/api/lab/harnesses/${run.harnessHash}`),
    fetchOrRecover<MemoryDto>(`/api/lab/memory/${run.harnessHash}`),
    fetchOrRecover<MeResponse>('/auth/me'),
  ]);
  return (
    <main style={{ padding: 16 }}>
      <p>
        <Link href="/lab">← Lab</Link>{' '}
        <span style={{ color: '#6b7688', fontSize: 12 }}>
          run <code>{id}</code> of {harness.name}
        </span>
      </p>
      <LabFormView harness={harness} memory={memory} runId={id} initialRun={run} role={me.role} surface="run" />
    </main>
  );
}

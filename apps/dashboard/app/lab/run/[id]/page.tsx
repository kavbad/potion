// /lab/run/[id] (Step 9) — the run seen THROUGH the derived form: the same
// poll, rendered as the organism's own luminosity. The narration timeline
// remains available via the report; the answer/kill/report controls ride
// the form's overlay through the same real routes as Step 8.
import Link from 'next/link';
import { fetchOrRecover } from '@/lib/recover';
import { LabConsole } from '@/components/lab-console';
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
  const files = await fetchOrRecover<{ files: Array<{ name: string; mime: string; size: number; sha256: string }> }>(
    `/api/lab/runs/${id}/files`,
  ).catch(() => ({ files: [] as Array<{ name: string; mime: string; size: number; sha256: string }> }));
  return (
    <main className="mx-auto max-w-5xl">
      <nav className="mb-3 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        <Link href="/lab" className="text-soft hover:text-accent">Agents</Link>
        {' · '}<Link href={`/lab/harness/${run.harnessHash}`} className="text-soft hover:text-accent">{harness.name}</Link>
        {' · '}run <code className="normal-case">{id.slice(0, 12)}…</code>
      </nav>
      {files.files.length > 0 ? (
        <section className="mb-4 border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4" data-testid="run-files">
          <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-accent">
            files this run produced · {files.files.length}
          </div>
          <ul className="mt-2 grid gap-1.5">
            {files.files.map((f) => (
              <li key={f.name} className="flex flex-wrap items-baseline gap-x-3 font-mono text-[13px]">
                <a href={`/api/lab/runs/${id}/files/${encodeURIComponent(f.name)}`} className="text-accent underline" download>
                  {f.name}
                </a>
                <span className="text-faint">{f.size.toLocaleString()} bytes · sha256 {f.sha256.slice(0, 12)}…</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <LabConsole harness={harness} memory={memory} runId={id} initialRun={run} role={me.role} surface="run" />
    </main>
  );
}

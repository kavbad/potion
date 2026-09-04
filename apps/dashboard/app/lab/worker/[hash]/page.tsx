// /lab/worker/[hash] — THE WORKER, AS A CONVERSATION (2026-09-03).
// The minimalist surface: the job and its work read as a thread, the bench
// beside it, settings as a pane. The deep specimen page (machinery, the
// permission ledger, the dial) stays at /lab/harness/[hash], one link away.
import Link from 'next/link';
import { fetchOrRecover } from '@/lib/recover';
import { LabChat } from '@/components/lab-chat';
import type { HarnessDto, RunDto } from '@potion/lab-form';

export const dynamic = 'force-dynamic';

interface RunsResponse {
  runs: Array<{ runId: string; state: string }>;
}

export default async function WorkerPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const [harness, runs] = await Promise.all([
    fetchOrRecover<HarnessDto>(`/api/lab/harnesses/${hash}`),
    fetchOrRecover<RunsResponse>(`/api/lab/harnesses/${hash}/runs`),
  ]);
  const latest = runs.runs[0] ?? null;
  const run = latest === null ? null : await fetchOrRecover<RunDto>(`/api/lab/runs/${latest.runId}`);
  return (
    <main className="mx-auto max-w-6xl">
      <nav className="mb-4 flex items-baseline justify-between gap-4 font-mono text-[12px] text-faint">
        <span>
          <Link href="/lab" className="text-soft hover:text-accent">
            Workers
          </Link>
          {' · '}
          <span className="text-ink">{harness.name}</span>
        </span>
        <code className="text-faint">{harness.harnessHash.slice(0, 8)}</code>
      </nav>
      <LabChat harness={harness} initialRunId={latest?.runId ?? null} initialRun={run} />
    </main>
  );
}

// /lab/run/[id] (Step 8) — live narration by POLLING durable rows; the
// est-vs-metered ticker; the check-in surface; the kill switch.
import Link from 'next/link';
import { RunView } from '@/components/lab-actions';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main style={{ padding: 16 }}>
      <p>
        <Link href="/lab">← Lab</Link>
      </p>
      <RunView runId={id} />
    </main>
  );
}

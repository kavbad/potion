// /lab (Step 8) — the novice entry: the four-question interview + the org's
// harness catalog. Ugly on purpose; every number and badge is data-typed.
import Link from 'next/link';
import { ApiUnreachable } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { InterviewForm } from '@/components/lab-actions';

export const dynamic = 'force-dynamic';

interface HarnessRow {
  harnessHash: string;
  name: string;
  clusterId: string;
  createdAt: string;
}

export default async function LabPage() {
  let harnesses: HarnessRow[] = [];
  let unreachable = false;
  try {
    const res = await fetchOrRecover<{ harnesses: HarnessRow[] }>('/api/lab/harnesses');
    harnesses = res.harnesses;
  } catch (e) {
    if (e instanceof ApiUnreachable) unreachable = true;
    else throw e;
  }
  return (
    <main style={{ padding: 16 }}>
      <h1>Potion Lab</h1>
      <p>Describe what you want done; get a harness with an honest dial.</p>
      {unreachable ? <p>API unreachable — start apps/server first.</p> : null}
      <InterviewForm />
      <h3>Your harnesses</h3>
      {harnesses.length === 0 ? <p data-testid="no-harnesses">None yet — build one above.</p> : null}
      <ul data-testid="harness-list">
        {harnesses.map((h) => (
          <li key={h.harnessHash}>
            <Link href={`/lab/harness/${h.harnessHash}`}>{h.name}</Link>{' '}
            <code>{h.clusterId}</code> <small>{h.harnessHash.slice(0, 12)}…</small>
          </li>
        ))}
      </ul>
    </main>
  );
}

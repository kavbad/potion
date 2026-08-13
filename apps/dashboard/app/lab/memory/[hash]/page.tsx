// /lab/memory/[hash] (Step 8) — what the harness remembers, in plain
// language; edit as text; deletion is PERMANENT (no tombstone). Edits do
// not disturb a leg in flight (legs snapshot reads at leg start); the NEXT
// leg sees the store as edited.
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { MemoryEntryEditor } from '@/components/lab-actions';

export const dynamic = 'force-dynamic';

interface MemoryDto {
  harnessHash: string;
  entries: Array<{ key: string; value: unknown; rendered: string; updatedAt: string }>;
}

export default async function MemoryPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const m = await apiFetch<MemoryDto>(`/api/lab/memory/${hash}`);
  return (
    <main style={{ padding: 16 }}>
      <p>
        <Link href={`/lab/harness/${hash}`}>← Harness</Link>
      </p>
      <h1>Harness memory</h1>
      <p>
        Edits apply from the <b>next</b> leg; a leg already running keeps the snapshot it started
        with. Deleting is permanent and immediate.
      </p>
      {m.entries.length === 0 ? <p data-testid="no-memory">Nothing remembered yet.</p> : null}
      <table border={1} cellPadding={4} data-testid="memory-table">
        <thead>
          <tr>
            <th>key</th>
            <th>value</th>
            <th>updated</th>
            <th>edit</th>
          </tr>
        </thead>
        <tbody>
          {m.entries.map((e) => (
            <tr key={e.key}>
              <td>
                <code>{e.key}</code>
              </td>
              <td>
                <pre style={{ margin: 0, maxWidth: 420, overflow: 'auto' }}>{e.rendered}</pre>
              </td>
              <td>
                <small>{e.updatedAt}</small>
              </td>
              <td>
                <MemoryEntryEditor
                  harnessHash={m.harnessHash}
                  entryKey={e.key}
                  initialText={typeof e.value === 'string' ? e.value : ''}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

// /lab — THE ROSTER (LAB-DESIGN.md, 2026-08-26): your workers, on the
// bench. The hire card is the hero — especially at day 2, when the roster
// is one newborn or none. Every chip on a specimen card is data: cluster,
// born date, and the trust-at-a-glance line from the grant record.
import Link from 'next/link';
import { ApiUnreachable } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { InterviewForm } from '@/components/lab-actions';
import { BENCH, BenchLabel, LabStage, SpecimenMark, TrustLine } from '@/components/lab-bench';

export const dynamic = 'force-dynamic';

interface HarnessRow {
  harnessHash: string;
  name: string;
  clusterId: string;
  createdAt: string;
  trust?: { autonomous: number; supervised: number; blocked: number };
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
    <LabStage>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.2em]" style={{ color: BENCH.faint }}>
        Potion Lab · where a company employs agents
      </div>
      <h1 className="mt-3 text-[2.2rem] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ color: '#eef2f8' }}>
        Your workers
      </h1>
      <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed" style={{ color: BENCH.muted }}>
        Every worker is born supervised: it asks before every external action, and each answer you
        give is evidence. Autonomy is earned per kind of action, proposed when the record clears the
        bar, granted by you — and taken back automatically the moment performance slips.
      </p>

      {unreachable && (
        <p className="mt-8 border px-5 py-4 text-sm" style={{ borderColor: BENCH.line, color: BENCH.muted }}>
          The Potion API is not reachable — start <code className="font-mono">apps/server</code> and reload.
        </p>
      )}

      {/* ---- the hire card: the hero, always first ---- */}
      <section className="mt-10 border px-7 py-6" style={{ borderColor: '#2a3346', background: BENCH.raised }}>
        <BenchLabel right="born supervised · budgeted · revocable">Hire a worker</BenchLabel>
        <InterviewForm />
      </section>

      {/* ---- the roster ---- */}
      <section className="mt-12">
        <BenchLabel right={harnesses.length > 0 ? `${harnesses.length} on the bench` : undefined}>
          The roster
        </BenchLabel>
        {harnesses.length === 0 ? (
          <p className="py-6 font-mono text-[12px]" style={{ color: BENCH.faint }} data-testid="no-harnesses">
            No workers yet. The first one starts above — one sentence about the job.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="harness-list">
            {harnesses.map((h) => (
              <li key={h.harnessHash}>
                <Link
                  href={`/lab/harness/${h.harnessHash}`}
                  className="flex items-start gap-4 border px-5 py-4 transition-colors"
                  style={{ borderColor: BENCH.line, background: BENCH.raised }}
                >
                  <SpecimenMark hash={h.harnessHash} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium" style={{ color: '#eef2f8' }}>
                      {h.name}
                    </span>
                    <span className="mt-0.5 block font-mono text-[10.5px]" style={{ color: BENCH.faint }}>
                      {h.clusterId} · born {new Date(h.createdAt).toLocaleDateString()} ·{' '}
                      <code>{h.harnessHash.slice(0, 8)}</code>
                    </span>
                    <span className="mt-1.5 block">
                      <TrustLine trust={h.trust ?? { autonomous: 0, supervised: 0, blocked: 0 }} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-14 font-mono text-[10.5px] leading-relaxed" style={{ color: BENCH.faint }}>
        permission is the output of evidence — there is no trust score · paperwork stays paper:
        ledgers and receipts render light, organisms render live
      </p>
    </LabStage>
  );
}

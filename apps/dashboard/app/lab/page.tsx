// /lab — THE ROSTER (LAB-DESIGN.md v2, 2026-08-27): your workers, in
// daylight. The hire card is the hero — especially at day 2, when the
// roster is one newborn or none. Every chip on a specimen card is data:
// cluster, born date, and the trust-at-a-glance line from the grant record.
import Link from 'next/link';
import { ApiUnreachable } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { InterviewForm } from '@/components/lab-actions';
import { MissionGallery } from '@/components/lab-gallery';
import { RunTheater } from '@/components/lab-theater';
import { BenchLabel, CARD, LabStage, SpecimenMark, TrustLine } from '@/components/lab-bench';

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
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        Agents · supervised first, trusted per action
      </div>
      <h1 className="mt-3 text-[2.2rem] font-semibold leading-[1.05] tracking-[-0.025em] text-ink">
        Your workers
      </h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">
        Every worker is born supervised: it asks before every external action, and each answer you
        give is evidence. Autonomy is earned per kind of action, proposed when the record clears the
        bar, granted by you — and taken back automatically the moment performance slips.
      </p>

      {unreachable && (
        <p className={`mt-8 ${CARD} px-5 py-4 text-sm text-soft`}>
          The Potion API is not reachable — start <code className="font-mono">apps/server</code> and reload.
        </p>
      )}

      {/* ---- the hire card: the hero, always first ---- */}
      {/* H1 (2026-08-31): the machine, visibly working, before any form —
           a real recorded run replayed. The first feeling is the product
           doing real work, not a config page. */}
      <RunTheater />

      <section className={`mt-10 ${CARD} px-7 py-6 shadow-paper`}>
        <BenchLabel right="born supervised · budgeted · revocable">Hire a worker</BenchLabel>
        <InterviewForm />
      </section>

      {/* ---- the roster ---- */}
      <MissionGallery />

      <section className="mt-12">
        <BenchLabel right={harnesses.length > 0 ? `${harnesses.length} on the roster` : undefined}>
          The roster
        </BenchLabel>
        {harnesses.length === 0 ? (
          <p className="py-6 font-mono text-[12px] text-faint" data-testid="no-harnesses">
            No workers yet. The first one starts above — one sentence about the job.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="harness-list">
            {harnesses.map((h) => (
              <li key={h.harnessHash}>
                <Link
                  href={`/lab/harness/${h.harnessHash}`}
                  className={`flex items-start gap-4 ${CARD} px-5 py-4 transition-shadow hover:shadow-paper`}
                >
                  <SpecimenMark hash={h.harnessHash} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium text-ink">
                      {h.name}
                    </span>
                    <span className="mt-0.5 block font-mono text-[12px] text-faint">
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

      <p className="mt-14 font-mono text-[12px] leading-relaxed text-faint">
        permission is the output of evidence — there is no trust score
      </p>
    </LabStage>
  );
}

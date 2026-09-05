// /lab — ONE BOX (2026-09-03, operator: "a single prompt box, everything
// else auto-filled by AI; the best premade examples are the prompt area").
//
// What this page was: a theater, a fourteen-field interview, a species
// gallery, and a roster — four sections before a first-time visitor could
// act. What it is now: a sentence box, the examples inside it, and the
// roster underneath. Advanced settings are one click inside the box, and
// they are the same form as before, not a second implementation.
import Link from 'next/link';
import { ApiUnreachable } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { LabCompose } from '@/components/lab-compose';
import { CARD, LabStage, TrustLine } from '@/components/lab-bench';
import { LabWaiting, type WaitingRun } from '@/components/lab-waiting';

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
  let waiting: WaitingRun[] = [];
  let unreachable = false;
  try {
    const res = await fetchOrRecover<{ harnesses: HarnessRow[]; waiting?: WaitingRun[] }>(
      '/api/lab/harnesses',
    );
    harnesses = res.harnesses;
    waiting = res.waiting ?? [];
  } catch (e) {
    if (e instanceof ApiUnreachable) unreachable = true;
    else throw e;
  }
  return (
    <LabStage>
      {/* Above the box on purpose: answering a worker that is already
          waiting finishes work that exists, which beats starting more. */}
      <LabWaiting waiting={waiting} />

      <div className="pt-6">
        <h1 className="text-[2rem] font-medium leading-[1.1] tracking-[-0.025em] text-ink">
          What should it do?
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-soft">
          Describe a job in one or two sentences. Potion builds the worker around it — what kind of
          work it is, which measured models fit, and what done means.
        </p>

        <div className="mt-6">
          <LabCompose />
        </div>
      </div>

      {unreachable && (
        <p className={`mt-8 ${CARD} px-5 py-4 text-sm text-soft`}>
          The Potion API is not reachable — start <code className="font-mono">apps/server</code> and reload.
        </p>
      )}

      {harnesses.length > 0 ? (
        <section className="mt-16">
          <div className="flex items-baseline justify-between border-b border-line pb-2 font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
            <span>your workers</span>
            <span>{harnesses.length}</span>
          </div>
          <ul className="divide-y divide-line" data-testid="harness-list">
            {harnesses.map((h) => (
              <li key={h.harnessHash}>
                <Link
                  href={`/lab/worker/${h.harnessHash}`}
                  className="flex items-baseline justify-between gap-4 py-3 transition-colors hover:text-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] text-ink">{h.name}</span>
                    <span className="mt-0.5 block font-mono text-[12px] text-faint" suppressHydrationWarning>
                      {h.clusterId} · born {new Date(h.createdAt).toLocaleDateString('en-US')}
                    </span>
                  </span>
                  <span className="shrink-0">
                    <TrustLine trust={h.trust ?? { autonomous: 0, supervised: 0, blocked: 0 }} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-16 font-mono text-[12px] leading-relaxed text-faint">
        every worker is born supervised · permission is the output of evidence · there is no trust score
      </p>
    </LabStage>
  );
}

// "A WORKER IS WAITING FOR YOU" (2026-09-05).
//
// A parked run sends exactly one email, at the moment it parks, and then
// says nothing for the rest of its life. That was the whole notification.
// On production a run has been sitting in awaiting-human since
// 2026-08-31 — the person missed one mail, and no surface anywhere in the
// product told them a worker wanted something. It is still waiting.
//
// One email is a nudge, not a system. The system is this: the place
// somebody looks when they think about their workers says, in plain
// words, which ones want them — and it keeps saying it until they answer.
// The email can be missed. A standing signal cannot.
//
// It leads with the QUESTION, not the worker's name. "analyze-data-file-
// with-totals-chart-and-summary needs a decision" tells you nothing you
// can act on; "Should I use the 2024 sheet or the 2025 one?" tells you
// everything, and is answerable in the four seconds someone will give it.
import Link from 'next/link';

export interface WaitingRun {
  runId: string;
  harnessHash: string;
  harnessName: string;
  question: string | null;
  since: string;
}

/** How long it has been waiting, in the roughest honest unit. Rough on
 * purpose: "5 days" is the fact that matters, and the reader does not need
 * to be told it has been 4 days and 19 hours. */
export function waitedFor(since: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function LabWaiting({ waiting }: { waiting: WaitingRun[] }) {
  if (waiting.length === 0) return null;
  return (
    <section
      className="mt-8 border border-warn bg-white px-5 py-4"
      aria-live="polite"
      data-testid="waiting-banner"
    >
      <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-warn">
        {waiting.length === 1 ? 'a worker is waiting for you' : `${waiting.length} workers are waiting for you`}
      </div>
      <ul className="mt-3 space-y-3">
        {waiting.map((w) => (
          <li key={w.runId}>
            <Link
              href={`/lab/run/${w.runId}`}
              className="group block"
              data-testid={`waiting-${w.runId}`}
            >
              <span className="block text-[15px] leading-relaxed text-ink group-hover:text-accent">
                {w.question ?? 'It paused and needs a decision from you.'}
              </span>
              <span className="mt-0.5 block font-mono text-[12px] text-soft" suppressHydrationWarning>
                {w.harnessName} · waiting {waitedFor(w.since)} ·{' '}
                <span className="text-accent underline decoration-line underline-offset-4 group-hover:decoration-accent">
                  answer it
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

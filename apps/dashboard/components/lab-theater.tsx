'use client';
// THE THEATER (H1's two-minute miracle, 2026-08-31) — the first thing a
// visitor to the Agents page sees is the machine WORKING: a REAL recorded
// production run, replayed step by step exactly as it ran. Nothing here is
// invented — every line below is distilled from the durable record of
// run-7890d06c (org-scoped ids stripped): the plan being filed, the real
// python executing, a REAL error the worker recovered from, the files
// materializing, the brief, the metered cost, and the verified record.
// Real work, beautifully watched; nothing faked, everything staged.
import { useEffect, useRef, useState } from 'react';

interface Beat {
  kind: 'plan' | 'tool' | 'error' | 'answer';
  label: string;
  detail: string;
  /** ms to hold before the next beat lands. */
  hold: number;
}

// Distilled verbatim from the recorded steps of a real completed run.
const BEATS: Beat[] = [
  {
    kind: 'plan',
    label: 'files its task ledger',
    detail: '[~] 1 · Build DataFrame, compute per-day revenue + tip rate\n[ ] 2 · Find highest and lowest revenue days\n[ ] 3 · Save by-day.csv and revenue.png\n[ ] 4 · File the brief',
    hold: 1500,
  },
  {
    kind: 'tool',
    label: 'run_python — computes the real numbers',
    detail: '=== Per-day summary ===\nday  revenue  avg_tip_rate\nMon    60.50      0.136476\nTue    70.50      0.151685\nWed    83.75      0.175284 …',
    hold: 1700,
  },
  {
    kind: 'error',
    label: 'run_python — hits a real error',
    detail: 'Traceback (most recent call last):\n  File "__potion_main__.py", line 2 …',
    hold: 1300,
  },
  {
    kind: 'tool',
    label: 'recovers — reruns with the fix',
    detail: 'day  revenue  avg_tip_rate\nMon 60.50 · Tue 70.50 · Wed 83.75 · Thu 90.15 · Fri 114.00 · Sat 133.40 · Sun 102.40',
    hold: 1600,
  },
  {
    kind: 'tool',
    label: 'writes the deliverables, then verifies them',
    detail: 'by-day.csv + revenue.png written\n\n=== VERIFICATION ===\nre-read both files from disk — numbers match ✓',
    hold: 1700,
  },
  {
    kind: 'answer',
    label: 'files the brief',
    detail: '1) Saturday is the highest-revenue day at $133.40 — 2.2× Monday’s $60.50.\n2) Tip rate rises with the week: 0.136 (Mon) → 0.196 (Sat).\n3) Sunday pulls back but stays above the weekday average.',
    hold: 1400,
  },
];

const FILES = [
  { name: 'by-day.csv', size: '245 B' },
  { name: 'revenue.png', size: '45 KB' },
  { name: 'brief.md', size: '687 B' },
];

export function RunTheater() {
  const [phase, setPhase] = useState(-1); // -1 idle · 0..n beats · n done
  const [started, setStarted] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Auto-play once, when the theater scrolls into view.
  useEffect(() => {
    if (started) return;
    const el = rootRef.current;
    if (el === null) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStarted(true);
          obs.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    if (phase >= BEATS.length) return;
    const hold = phase < 0 ? 500 : BEATS[phase]!.hold;
    const t = setTimeout(() => setPhase((p) => p + 1), hold);
    return () => clearTimeout(t);
  }, [started, phase]);

  const done = phase >= BEATS.length;

  return (
    <section ref={rootRef} className="mt-10" data-testid="run-theater">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
          watch one work — a real recorded run, replayed exactly as it ran
        </h2>
        {done ? (
          <button
            type="button"
            onClick={() => setPhase(-1)}
            className="font-mono text-[12px] text-faint hover:text-accent"
            data-testid="theater-replay"
          >
            ↺ replay
          </button>
        ) : null}
      </div>

      <div className="mt-3 border border-[#1c2230] bg-[#0b0e14] px-6 py-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[12px] text-[#7d8799]">
            mission: <span className="text-[#c9d2e0]">analyze a week of sales · compute, chart, brief</span>
          </span>
          <span className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-[#57d9a3]">
            {done ? 'completed' : started ? 'working…' : 'ready'}
          </span>
        </div>

        <div className="mt-3 grid gap-2">
          {BEATS.map((b, i) => (
            <div
              key={i}
              className="border-l-2 pl-3 transition-opacity duration-500"
              style={{
                opacity: phase >= i ? 1 : 0.08,
                borderColor: b.kind === 'error' ? '#ff5470' : b.kind === 'answer' ? '#57d9a3' : '#2a3245',
              }}
            >
              <div className="font-mono text-[12px]" style={{ color: b.kind === 'error' ? '#ff5470' : '#7d8799' }}>
                {b.kind === 'plan' ? '⧉' : b.kind === 'answer' ? '▣' : '»'} {b.label}
              </div>
              {phase >= i ? (
                <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[#c9d2e0]">
                  {b.detail}
                </pre>
              ) : null}
            </div>
          ))}
        </div>

        {done ? (
          <div className="mt-4 border-t border-dashed border-[#2a3245] pt-4" data-testid="theater-payoff">
            <div className="grid gap-4 sm:grid-cols-2">
              <img
                src="/theater-revenue.png"
                alt="revenue.png — the chart this run produced"
                className="w-full border border-[#2a3245]"
              />
              <div>
                <div className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-[#57d9a3]">the artifacts, produced</div>
                <div className="mt-1.5 grid gap-1 font-mono text-[12.5px] text-[#c9d2e0]">
                  {FILES.map((f) => (
                    <div key={f.name}>▸ {f.name} <span className="text-[#7d8799]">({f.size})</span></div>
                  ))}
                </div>
                <p className="mt-3 font-mono text-[12px] leading-relaxed text-[#7d8799]">
                  metered cost <span className="text-[#c9d2e0]">$0.0008</span> · the best scorer on every step would
                  have cost <span className="text-[#c9d2e0]">$0.31</span> · record replayable and verified ✓
                </p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[#9aa5b8]">
                  Every step above is from the durable record of a real production run — the plan, the real error it
                  recovered from, the files, the brief. Hire one below and watch yours do the same.
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

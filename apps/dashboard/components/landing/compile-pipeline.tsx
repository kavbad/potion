// THE COMPILE PIPELINE — the hero instrument. One real request, compiled in
// front of you, left to right.
//
// THIS IS v3. What the first two got wrong, because the corrections are the
// design:
//
//   v1  ONE WIDE SVG WITH TEXT IN IT. At 375px the viewBox scaled to 0.34 and
//       labels rendered at 3.9px. Now every word is HTML at a real size and
//       only GEOMETRY is SVG, so the panels stack on a phone and stay legible.
//   v2  ONE RULE, FOREVER. Every request was min_cost under a 0.95 floor, so
//       the page showed a system with a single knob (operator: "the rules seem
//       too basic ... they do not show the range"). PolicySchema takes three
//       kinds of outcome bound, and each one is a DIFFERENT SHAPE on the
//       field:
//
//         min_cost       a quality FLOOR      — a horizontal line; the search
//                                               runs up the cost axis and
//                                               stops at the first survivor
//         max_quality    a cost CEILING       — a vertical line; the search
//                                               runs down from the top and
//                                               stops at the best point left
//                                               of it
//         latency_bound  a p95 BUDGET         — encoded in the DOT SIZE (the
//                                               house convention: bigger dot =
//                                               slower); everything too slow
//                                               hollows out, then quality wins
//
//       The constraint is not a caption. It is drawn, and it is drawn
//       differently each time, because that is what the product actually
//       accepts.
//
// THE PICK IS COMPUTED, NEVER QUOTED. select() below is the same law the
// frontier explorer runs (components/landing/frontier-explorer.tsx) applied to
// the same committed points (lib/evidence FIELD). If it quoted ROUTE_DEMO's
// recorded label while showing a different policy, the panel and the plot
// would disagree — a caption-vs-provenance lie of exactly the kind this page
// exists to avoid. Change the rule and the emitted plan changes, because it is
// derived.
//
// Thresholds are DERIVED FROM THE FIELD (a ceiling at the field's median cost,
// a budget at its median p95) so the rule always has something to select and
// the number shown is always a real one.
//
// THE SIXTH REQUEST LOSES ON PURPOSE: creative work pays full price because
// nothing cheaper measures good enough. A loop that wins six times out of six
// is an advertisement; one that loses in public is a measurement.
//
// House rules: warm paper, ONE teal, hairlines, mono for data, no gradients,
// no glow. The withheld model arrives masked in the data and its name never
// enters the DOM. Reduced motion gets the settled frame.
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FIELD, ROUTE_DEMO } from '@/lib/evidence';
import { premiumCostFor } from '@/lib/economics';
import { latencyRadius } from '@/lib/frontier-chart';

const ACCENT = '#0f766e';
const INK = '#1c1a17';
const RULE = '#b8b3a6';
const DIM = '#d9d5cb';
const PAPER = '#fbfaf7';
const FLOOR = 0.95;

const PW = 330;
const PH = 214;
const PAD = { l: 16, r: 16, t: 16, b: 24 };

/** ms per phase: read, classify, recall, shapes, constrain, search, emit, hold */
const STEPS = [600, 520, 800, 950, 700, 950, 850, 1700] as const;
const PHASES = STEPS.length;

type Kind = 'min_cost' | 'max_quality' | 'latency_bound';

/** Which outcome bound each request is served under. Cycling these is the
 *  whole point: one rule looks like one knob. */
const POLICY: Record<string, Kind> = {
  classification: 'min_cost',
  'code-gen': 'min_cost',
  extraction: 'max_quality',
  'rag-answer': 'latency_bound',
  'multi-step-reasoning': 'min_cost',
  creative: 'min_cost',
};

/** THE SHAPES IT CAN EMIT, and the standing verdict on them.
 *
 *  This is deliberately COPY, not a mirror of KNOWN_STRATEGY_TYPES in
 *  lib/frontier-chart.ts: a second copy of a type union is a drift defect, and
 *  the landing page needs the words a buyer knows, not the enum.
 *
 *  THE VERDICT IS A STANDING MEASUREMENT, NOT A LIVE SEARCH — and the copy
 *  must not imply otherwise. Potion does not audition a cascade on your
 *  request while you wait. The multi-model shapes were measured against the
 *  best single model, pre-registered and budget-capped, and every one lost;
 *  the losses are published. That result is WHY the emitted plan is one node
 *  today, which is the honest answer to "why does this look so simple". */
const SHAPES = [
  { name: 'single', wins: true },
  { name: 'cascade', wins: false },
  { name: 'best-of-n', wins: false },
  { name: 'draft-verify', wins: false },
  { name: 'ensemble', wins: false },
  { name: 'decompose', wins: false },
] as const;

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const usdBig = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

interface Pt {
  x: number;
  y: number;
  hi: number;
  lo: number;
  r: number;
  keep: boolean;
  chosen: boolean;
}

function useFrame(i: number) {
  return useMemo(() => {
    const d = ROUTE_DEMO[i % ROUTE_DEMO.length]!;
    const pts = FIELD[d.cluster] ?? [];
    const kind: Kind = POLICY[d.cluster] ?? 'min_cost';

    // Derived so the rule always has something to select, and so the number
    // the panel prints is a real one off this field.
    const bound =
      kind === 'min_cost'
        ? FLOOR
        : kind === 'max_quality'
          ? median(pts.map((p) => p.costPer1K))
          : median(pts.map((p) => p.p95Ms));

    // THE SELECTION LAW — the frontier explorer's select(), same shape.
    const keep = (p: (typeof pts)[number]) =>
      kind === 'min_cost' ? p.quality >= bound : kind === 'max_quality' ? p.costPer1K <= bound : p.p95Ms <= bound;
    const kept = pts.filter(keep);
    const pick =
      kept.length === 0
        ? null
        : kind === 'min_cost'
          ? kept.reduce((a, b) => (a.costPer1K <= b.costPer1K ? a : b))
          : kept.reduce((a, b) =>
              b.quality > a.quality || (b.quality === a.quality && b.costPer1K < a.costPer1K) ? b : a,
            );

    const lg = (c: number) => Math.log10(Math.max(c, 1e-4));
    const cs = pts.map((p) => lg(p.costPer1K));
    const clo = Math.min(...cs);
    const chi = Math.max(...cs);
    const qs = pts.flatMap((p) => [p.quality - p.ci, p.quality + p.ci]);
    const qlo = Math.min(...qs, FLOOR) - 0.01;
    const qhi = Math.max(...qs) + 0.01;
    const maxP95 = Math.max(...pts.map((p) => p.p95Ms), 1);

    const X = (c: number) => PAD.l + ((lg(c) - clo) / (chi - clo || 1)) * (PW - PAD.l - PAD.r);
    const Y = (q: number) => PH - PAD.b - ((q - qlo) / (qhi - qlo || 1)) * (PH - PAD.t - PAD.b);

    const plotted: Pt[] = pts.map((p) => ({
      x: X(p.costPer1K),
      y: Y(p.quality),
      hi: Y(Math.min(p.quality + p.ci, qhi)),
      lo: Y(Math.max(p.quality - p.ci, qlo)),
      // the third dimension, by the house convention: bigger dot = slower
      r: latencyRadius(p.p95Ms, maxP95) * 0.55,
      keep: keep(p),
      chosen: pick !== null && p.label === pick.label && p.costPer1K === pick.costPer1K,
    }));
    plotted.sort((a, b) => a.x - b.x);

    const premium =
      premiumCostFor(d.cluster) ?? pts.reduce((a, b) => (b.costPer1K > a.costPer1K ? b : a), pts[0]!).costPer1K;
    // Floor, never round, and never 100: 1/270th of the premium rounds to a
    // flat "−100%", a saving that reads as free, which is untrue.
    const saved = pick ? Math.min(99, Math.max(0, Math.floor((1 - pick.costPer1K / premium) * 100))) : 0;

    return {
      d,
      kind,
      bound,
      pick,
      premium,
      saved,
      cleared: saved > 0,
      points: plotted,
      kept: kept.length,
      boundX: kind === 'max_quality' ? X(bound) : 0,
      floorY: kind === 'min_cost' ? Y(FLOOR) : 0,
      pickX: plotted.find((p) => p.chosen)?.x ?? PAD.l,
      pickY: plotted.find((p) => p.chosen)?.y ?? PAD.t,
    };
  }, [i]);
}

/** THE "−0%" FLASH (operator, 2026-09-05) came from here. Two causes, both
 *  real: the counter starts at zero, so the first painted frame of every emit
 *  was a truthful-looking "−0%"; and between requests the panel still held the
 *  previous item's number while the next item's data was already in it. So the
 *  counter resets when the target changes, the first paint is seeded part-way
 *  up rather than at zero, and the panel below is UNMOUNTED until it emits
 *  instead of merely being transparent — transparent text is still text. */
function useCountUp(target: number, run: boolean) {
  const [n, setN] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => setN(0), [target]);
  useEffect(() => {
    if (!run) return;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 620);
      setN(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, run]);
  return run ? n || Math.round(target * 0.12) : 0;
}

function Cell({ n, label, children }: { n: string; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#fbfaf7] px-5 py-5">
      <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
        <span className="text-ink">{n}</span> · {label}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function CompilePipeline() {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setStill(true);
    }
  }, []);

  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => {
      if (phase < PHASES - 1) setPhase((p) => p + 1);
      else {
        setPhase(0);
        setI((k) => k + 1);
      }
    }, STEPS[phase]);
    return () => clearTimeout(t);
  }, [phase, still]);

  const f = useFrame(i);
  const p = still ? PHASES - 1 : phase;
  const on = (n: number) => p >= n;
  const emitting = still || p >= 6;
  const saved = useCountUp(f.saved, emitting);

  const ruleLine =
    f.kind === 'min_cost'
      ? `quality ≥ ${FLOOR.toFixed(2)}`
      : f.kind === 'max_quality'
        ? `cost ≤ ${usd(f.bound)} / 1k`
        : `p95 ≤ ${ms(f.bound)}`;
  const ruleBlurb =
    f.kind === 'min_cost'
      ? 'then spend as little as possible'
      : f.kind === 'max_quality'
        ? 'then buy the best quality it allows'
        : 'then buy the best quality that fits';

  const step = [
    'reading the request',
    'classifying the work',
    'recalling every measurement',
    'weighing the shapes it can emit',
    f.kind === 'min_cost' ? 'applying your floor' : f.kind === 'max_quality' ? 'applying your ceiling' : 'applying your latency budget',
    f.kind === 'min_cost' ? 'searching up the cost axis' : 'taking the best that survives',
    'emitting the plan',
    'emitting the plan',
  ][p]!;

  return (
    <div className="bg-[#e4e0d6]">
      <div className="flex items-baseline justify-between bg-[#fbfaf7] px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
        <span className="text-ink">The compiler, on one request</span>
        <span>
          {String((i % ROUTE_DEMO.length) + 1).padStart(2, '0')} / {String(ROUTE_DEMO.length).padStart(2, '0')} · real measurements
        </span>
      </div>

      <div className="grid gap-px md:grid-cols-[0.95fr_1.15fr_0.95fr]">
        {/* -------------------------------------------------- 01 SOURCE */}
        <Cell n="01" label="Source">
          <p className="font-mono text-[13px] leading-relaxed text-ink">&ldquo;{f.d.prompt}&rdquo;</p>
          <div className="mt-5 transition-opacity duration-300" style={{ opacity: on(1) ? 1 : 0.2 }}>
            <div className="font-mono text-[12px] uppercase tracking-[0.1em] text-faint">Kind of work</div>
            <div className="mt-1 font-mono text-[13.5px] text-ink">{f.d.cluster}</div>
          </div>
          <div className="mt-5">
            <div className="font-mono text-[12px] uppercase tracking-[0.1em] text-faint">Your rule</div>
            <div className="mt-1 font-mono text-[13px] text-faint">{f.kind}</div>
            <div className="mt-0.5 font-mono text-[13.5px] text-accent">{ruleLine}</div>
            <div className="mt-0.5 font-mono text-[12px] text-faint">{ruleBlurb}</div>
          </div>
        </Cell>

        {/* -------------------------------------------------- 02 COMPILE */}
        <Cell n="02" label="Compile">
          <div className="mx-auto w-full max-w-[360px]">
            <svg viewBox={`0 0 ${PW} ${PH}`} className="block w-full" role="img"
              aria-label={`The measured field for ${f.d.cluster}. Dot size is p95 latency. Under ${f.kind} at ${ruleLine}, ${f.kept} of ${f.points.length} points survive and the compiler takes ${f.cleared ? 'the one it selects' : 'the strong model at full price'}.`}>
              <line x1={PAD.l} y1={PH - PAD.b} x2={PW - PAD.r} y2={PH - PAD.b} stroke={RULE} />
              <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PH - PAD.b} stroke={RULE} />

              {/* THE CONSTRAINT, DRAWN AS ITS OWN SHAPE */}
              {f.kind === 'min_cost' && (
                <line x1={PAD.l} y1={f.floorY} x2={PW - PAD.r} y2={f.floorY} stroke={ACCENT} strokeDasharray="3 3"
                  style={{ opacity: on(4) ? 1 : 0, transition: 'opacity .45s' }} />
              )}
              {f.kind === 'max_quality' && (
                <line x1={f.boundX} y1={PAD.t} x2={f.boundX} y2={PH - PAD.b} stroke={ACCENT} strokeDasharray="3 3"
                  style={{ opacity: on(4) ? 1 : 0, transition: 'opacity .45s' }} />
              )}

              {/* the search, moving the way the rule searches */}
              <g style={{
                opacity: on(5) ? 1 : 0,
                transform: f.kind === 'min_cost' ? `translateX(${on(5) ? f.pickX - PAD.l : 0}px)` : `translateY(${on(5) ? f.pickY - PAD.t : 0}px)`,
                transition: 'transform .95s cubic-bezier(.33,.9,.3,1), opacity .3s',
              }}>
                {f.kind === 'min_cost' ? (
                  <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PH - PAD.b} stroke={ACCENT} opacity="0.45" />
                ) : (
                  <line x1={PAD.l} y1={PAD.t} x2={PW - PAD.r} y2={PAD.t} stroke={ACCENT} opacity="0.45" />
                )}
              </g>

              {f.points.map((pt, n) => {
                const out = on(4) && !pt.keep;
                const lit = on(5) && pt.chosen;
                return (
                  <g key={n} style={{ opacity: on(2) ? 1 : 0, transition: `opacity .4s ${still ? 0 : n * 45}ms` }}>
                    <line x1={pt.x} y1={pt.hi} x2={pt.x} y2={pt.lo} stroke={out ? DIM : RULE} />
                    <line x1={pt.x - 3} y1={pt.hi} x2={pt.x + 3} y2={pt.hi} stroke={out ? DIM : RULE} />
                    <line x1={pt.x - 3} y1={pt.lo} x2={pt.x + 3} y2={pt.lo} stroke={out ? DIM : RULE} />
                    <circle cx={pt.x} cy={pt.y} r={pt.r} fill={lit ? ACCENT : out ? PAPER : INK}
                      stroke={lit ? ACCENT : out ? DIM : INK} strokeWidth="1.4"
                      style={{ transition: 'fill .4s, stroke .4s' }} />
                    {lit && <circle cx={pt.x} cy={pt.y} r={pt.r + 6} fill="none" stroke={ACCENT} opacity="0.5" />}
                  </g>
                );
              })}
            </svg>

            <div className="mt-2 flex items-baseline justify-between font-mono text-[12px] text-faint">
              <span>cheaper →</span>
              <span>↑ measured quality</span>
            </div>
          </div>
          {/* the shapes, weighed and struck in front of you */}
          <div className="mt-4 border-t border-[#e4e0d6] pt-3">
            <div className="font-mono text-[12px] uppercase tracking-[0.1em] text-faint">
              Shapes it can emit
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 font-mono text-[12px]">
              {SHAPES.map((sh, n) => {
                const struck = on(3) && !sh.wins;
                const kept = on(3) && sh.wins;
                return (
                  <span
                    key={sh.name}
                    className={kept ? 'text-accent' : struck ? 'text-faint line-through' : 'text-soft'}
                    style={{ transition: `color .35s ${still ? 0 : n * 70}ms`, textDecorationThickness: '1px' }}
                  >
                    {sh.name}
                  </span>
                );
              })}
            </div>
            <div className="mt-2 font-mono text-[12px] leading-relaxed text-faint">
              {on(3)
                ? 'the multi-model shapes were measured against the best single model — pre-registered, budget-capped — and lost. Re-measured weekly: when one wins, it compiles in and you change nothing.'
                : 'every shape is a candidate until measurement says otherwise'}
            </div>
          </div>

          <div className="mt-4 font-mono text-[12.5px] text-accent">{step}</div>
          <div className="mt-1 font-mono text-[12px] leading-relaxed text-faint">
            dot size is p95 latency · {f.kept} of {f.points.length} points survive your rule
          </div>
        </Cell>

        {/* -------------------------------------------------- 03 EMIT */}
        <Cell n="03" label="Emit">
          {/* Unmounted until it emits: an opacity-0 panel still carries its
              text, which is what leaked the stale number between requests. */}
          <div>
            {emitting && f.pick && (
              <>
                <div className="font-mono text-[12px] uppercase tracking-[0.1em] text-faint">Served by</div>
                <div className="mt-1 font-mono text-[13.5px] text-ink">{f.pick.label}</div>
                <div className="mt-1 font-mono text-[12px] leading-relaxed text-faint">
                  quality {f.pick.quality.toFixed(3)} · {usd(f.pick.costPer1K)} / 1k
                  <br />
                  p95 {ms(f.pick.p95Ms)}
                </div>

                {f.cleared ? (
                  <>
                    <div className="mt-5 font-mono text-[3.1rem] leading-none tracking-[-0.03em] text-accent">
                      −{saved}%
                    </div>
                    <div className="mt-2 font-mono text-[12px] leading-relaxed text-faint">
                      against one model for everything
                    </div>
                    <div className="mt-3 font-mono text-[13px] text-ink">
                      {usd(f.premium)} → {usd(f.pick.costPer1K)} / 1k
                    </div>
                    <div className="mt-4 border-t border-[#d9d5cb] pt-3 font-mono text-[12px] leading-relaxed text-faint">
                      at a million requests of this work
                      <br />
                      <span className="text-ink">
                        {usdBig(f.premium * 1000)} → {usdBig(f.pick.costPer1K * 1000)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    {/* WHY THERE IS NO SAVING DEPENDS ON THE RULE, and saying
                        the wrong one is a lie about the mechanism. Under
                        min_cost, paying the top price means nothing cheaper
                        cleared the floor. Under max_quality or latency_bound
                        the customer did not ask for cheap at all — cheaper
                        points survive, the rule simply does not optimise for
                        them — so claiming "nothing cheaper is good enough"
                        there would be false. */}
                    <div className="mt-5 font-mono text-[1.9rem] leading-none tracking-[-0.02em] text-ink">
                      {f.kind === 'min_cost' ? 'full price' : 'top of your bound'}
                    </div>
                    <div className="mt-2 font-mono text-[12px] leading-relaxed text-faint">
                      {f.kind === 'min_cost'
                        ? 'nothing cheaper measures good enough here — so the compiler pays it, and the receipt says so'
                        : 'you asked for the best that fits, not the cheapest — cheaper points cleared your bound and the rule passed them over'}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </Cell>
      </div>
    </div>
  );
}

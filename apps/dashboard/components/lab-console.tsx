'use client';
// THE WORKBENCH CONSOLE (LAB-DESIGN v3, 2026-08-27) — the worker's primary
// surface, redesigned from first principles after the operator's verdict on
// the abstract organism ("i still dont know what im looking at").
//
// The surface exists to answer four questions at a glance:
//   1. WHAT IS THIS WORKER      → the anatomy rail (mission, brain, budget,
//                                 accounts, rules, memory — every value the
//                                 live parameter, edits through real routes)
//   2. WHAT IS IT DOING         → the work feed (the durable step record,
//                                 narrated plainly: thought / action / asked)
//   3. WHAT IS IT ASKING ME     → the question card, impossible to miss —
//                                 answering is the product's heartbeat
//   4. WHAT IS IT COSTING       → the fuel bar: metered truth vs the hard
//                                 cap, est. labeled separately, never blended
//
// What survives from the organism: EVERYTHING except the paint. The same
// deriveFormState derivation (audited, pixel-to-parameter), the same 1.5s
// poll over durable rows, the same honesty plumbing — metered/est duality,
// SIMULATED badges, typed staleness, brain-only truth, frozen-spec runs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUDIT,
  deriveFormState,
  type FormState,
  type HarnessDto,
  type MemoryDto,
  type RunDto,
} from '@potion/lab-form';
import { BriefView } from './lab-brief';

const POLL_MS = 1500;
const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);

const CARD = 'border border-[#d9d5cb] bg-[#fbfaf7]';
const EYEBROW = 'font-mono text-[12px] uppercase tracking-[0.13em] text-faint';
const CHIP = 'inline-flex items-center border px-1.5 py-px font-mono text-[11px] uppercase tracking-[0.08em]';

const STATE_LABEL: Record<string, string> = {
  idle: 'idle — has not run yet',
  pending: 'starting…',
  running: 'working',
  'awaiting-human': 'waiting for your answer',
  completed: 'completed',
  failed: 'failed',
  'killed-budget': 'stopped at the budget cap',
  'killed-operator': 'stopped by you',
};
const STATE_CLS: Record<string, string> = {
  idle: 'border-[#c4bfb2] text-soft',
  pending: 'border-accent text-accent',
  running: 'border-accent text-accent',
  'awaiting-human': 'border-warn text-warn',
  completed: 'border-kept text-kept',
  failed: 'border-refuse text-refuse',
  'killed-budget': 'border-refuse text-refuse',
  'killed-operator': 'border-[#c4bfb2] text-soft',
};

function leafValue(state: FormState, path: string): unknown {
  let v: unknown = state;
  for (const part of path.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
  return v;
}

function SimBadge() {
  return <span className={`${CHIP} border-warn text-warn`}>simulated</span>;
}

/** One row of the work feed — a step from the durable record, in plain
 * words. Nothing streams, nothing is invented: this is the checkpoint row. */
function FeedRow({ step }: { step: NonNullable<RunDto['steps']>[number] }) {
  const t = new Date(step.at);
  const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  const kindLabel = step.kind === 'model' ? 'thought' : step.kind === 'tool' ? 'action' : 'asked you';
  const kindCls =
    step.kind === 'check-in' ? 'border-warn text-warn' : step.kind === 'tool' ? 'border-accent text-accent' : 'border-[#c4bfb2] text-faint';
  return (
    <li className="border-b border-dashed border-[#d9d5cb] py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11.5px] tabular-nums text-faint">{hh}</span>
        <span className={`${CHIP} ${kindCls}`}>{kindLabel}</span>
        {step.kind === 'model' && step.simulated === true ? <SimBadge /> : null}
        {step.fallback === true ? <span className={`${CHIP} border-warn text-warn`}>fallback</span> : null}
        {step.latencyViolated === true ? <span className={`${CHIP} border-warn text-warn`}>slow</span> : null}
        {step.kind === 'model' ? (
          <span className="font-mono text-[11.5px] tabular-nums text-faint">
            {step.costLabel === 'metered'
              ? `$${(step.meteredCostUsd ?? 0).toFixed(4)} metered`
              : `$${(step.estCostUsd ?? 0).toFixed(4)} est.`}
          </span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{step.excerpt}</p>
    </li>
  );
}

export function LabConsole({
  harness: initialHarness,
  memory: initialMemory,
  runId: initialRunId,
  initialRun,
  role,
  surface,
}: {
  harness: HarnessDto;
  memory: MemoryDto;
  runId?: string | null;
  initialRun?: RunDto | null;
  role: 'admin' | 'member' | 'viewer';
  /** The RUN page never rewrites its URL and never swaps the harness under
   * a live run (carried over from the organism, review findings intact). */
  surface: 'harness' | 'run';
}) {
  const [harness, setHarness] = useState(initialHarness);
  const [memory, setMemory] = useState(initialMemory);
  const [run, setRun] = useState<RunDto | null>(initialRun ?? null);
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [editedAway, setEditedAway] = useState<string | null>(null);
  const [derivedTick, setDerivedTick] = useState(0);

  const lastPollAt = useRef<number | null>(initialRun ? Date.now() : null);
  const runEpoch = useRef(0);
  const feedRef = useRef<HTMLOListElement | null>(null);
  const feedLen = useRef(0);

  const terminal = run !== null && TERMINAL.has(run.state);

  // The ONE derivation — same audited path the organism used. The tick
  // keeps the staleness clock honest (poll age is an audited input).
  const state = useMemo(() => {
    void derivedTick;
    const age = runId === null || lastPollAt.current === null ? null : Date.now() - lastPollAt.current;
    return deriveFormState(harness, memory, run, age);
  }, [harness, memory, run, runId, derivedTick]);

  // Poll the durable record — epoch-guarded against a swapped-away run; a
  // terminal run gets one final poll and then rests as 'settled'.
  useEffect(() => {
    if (runId === null) return;
    const epoch = runEpoch.current;
    const poll = async () => {
      try {
        const res = await fetch(`/api/lab/runs/${runId}`);
        if (res.ok && runEpoch.current === epoch) {
          setRun((await res.json()) as RunDto);
          lastPollAt.current = Date.now();
        }
      } catch {
        /* staleness reports this honestly — no retry theater */
      }
    };
    void poll();
    if (terminal) return;
    const t = setInterval(() => void poll(), POLL_MS);
    const staleTick = setInterval(() => setDerivedTick((n) => n + 1), 1000);
    return () => { clearInterval(t); clearInterval(staleTick); };
  }, [runId, terminal]);

  // Follow the work: keep the feed scrolled to the newest step.
  useEffect(() => {
    const steps = run?.steps ?? [];
    if (steps.length > feedLen.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
    feedLen.current = steps.length;
  }, [run]);

  // ---- actions through the REAL routes (unchanged from the organism) ----
  const refetchHarness = useCallback(async (hash: string) => {
    const res = await fetch(`/api/lab/harnesses/${hash}`);
    if (res.ok) {
      setHarness((await res.json()) as HarnessDto);
      const mem = await fetch(`/api/lab/memory/${hash}`);
      if (mem.ok) setMemory((await mem.json()) as MemoryDto);
      if (surface === 'harness' && hash !== initialHarness.harnessHash) {
        history.replaceState(null, '', `/lab/harness/${hash}`);
      }
    }
  }, [surface, initialHarness.harnessHash]);

  const liveRunAttached = runId !== null && (run === null || !TERMINAL.has(run.state));

  const applyEdit = useCallback(async (ops: unknown[]) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/lab/harnesses/${harness.harnessHash}/edit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      const body = (await res.json()) as { harnessHash?: string; unchanged?: boolean };
      if (res.ok && body.harnessHash && body.unchanged === false) {
        if (liveRunAttached) setEditedAway(body.harnessHash);
        else await refetchHarness(body.harnessHash);
      }
      return res.ok;
    } finally {
      setBusy(false);
    }
  }, [harness.harnessHash, refetchHarness, liveRunAttached]);

  const moveDial = useCallback(async (qualityIndex: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/lab/harnesses/${harness.harnessHash}/dial`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'brain', qualityIndex }),
      });
      const body = (await res.json()) as { harnessHash?: string };
      if (res.ok && body.harnessHash) {
        if (liveRunAttached) setEditedAway(body.harnessHash);
        else await refetchHarness(body.harnessHash);
      }
    } finally {
      setBusy(false);
    }
  }, [harness.harnessHash, refetchHarness, liveRunAttached]);

  const startTrial = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/lab/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harnessHash: harness.harnessHash }),
      });
      const body = (await res.json()) as { runId?: string };
      if (res.status === 202 && body.runId) {
        runEpoch.current += 1;
        lastPollAt.current = Date.now();
        setEditedAway(null);
        setRun(null);
        setRunId(body.runId);
      }
    } finally {
      setBusy(false);
    }
  }, [harness.harnessHash]);

  const [answerError, setAnswerError] = useState<string | null>(null);
  // X3 surfaces: the verify-record proof and the one-time first-run recap.
  const [verify, setVerify] = useState<{ busy: boolean; result: string | null }>({ busy: false, result: null });
  const [showRecap, setShowRecap] = useState(false);
  useEffect(() => {
    if (run === null || run.state !== 'completed') return;
    try {
      if (localStorage.getItem('potion:first-run-recap') === null) {
        localStorage.setItem('potion:first-run-recap', '1');
        setShowRecap(true);
      }
    } catch { /* private mode */ }
  }, [run]);
  const sendAnswer = useCallback(async () => {
    if (runId === null) return;
    const res = await fetch(`/api/lab/runs/${runId}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    if (res.status === 202) {
      setAnswer('');
      setAnswerError(null);
    } else {
      // 2026-08-27 incident: a swallowed 409 reads as a dead button. Say
      // what the run actually is; the next poll updates the whole console.
      const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setAnswerError(b?.error?.message ?? `answer failed (${res.status})`);
    }
  }, [runId, answer]);

  const kill = useCallback(() => {
    if (runId !== null) void fetch(`/api/lab/runs/${runId}/kill`, { method: 'POST' });
  }, [runId]);

  // ---- derived display ----
  const mode = state.glow.mode;
  const severed = state.filaments.filter((f) => f.connection !== 'connected').map((f) => f.id);
  const steps = run?.steps ?? [];
  const spec = harness.spec!;
  const views = (harness.dial.brain.views ?? []).filter((v) => v.feasible);
  const fuelFrac = Math.min(1, state.membrane.fuelCapUsd > 0 ? state.membrane.meteredUsd / state.membrane.fuelCapUsd : 0);
  const canStart = runId === null || terminal;

  return (
    <div
      data-testid="lab-form"
      data-harness-hash={harness.harnessHash}
      data-mission-kind={state.membrane.missionKind}
      data-severed={severed.length}
      data-connected={state.filaments.filter((f) => f.connection === 'connected').length}
      data-run-state={mode}
      data-laminations={state.membrane.laminations}
    >
      {/* ================= the status bar ================= */}
      <div className={`${CARD} flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5`}>
        <span className={`${CHIP} ${STATE_CLS[mode] ?? 'border-[#c4bfb2] text-soft'}`} data-testid="console-state">
          {STATE_LABEL[mode] ?? mode}
        </span>
        {state.glow.reason ? <span className="text-[12.5px] text-soft">{state.glow.reason}</span> : null}
        {state.staleness === 'disconnected' ? (
          <span className={`${CHIP} border-refuse text-refuse`}>view disconnected — showing last known state</span>
        ) : null}
        <span className="ml-auto flex items-center gap-3">
          {canStart ? (
            <button
              onClick={() => void startTrial()}
              disabled={busy}
              className="bg-ink px-4 py-1.5 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
              data-testid="form-start-trial"
            >
              run a supervised trial
            </button>
          ) : (
            <button
              onClick={kill}
              className="border border-refuse px-4 py-1.5 text-[13px] font-medium text-refuse hover:bg-refuse-soft"
              data-testid="form-kill"
            >
              stop this run
            </button>
          )}
          {terminal ? (
            <a href={`/lab/run/${runId}/report`} className="text-[13px] text-accent underline" data-testid="form-report-link">
              open the report →
            </a>
          ) : null}
        </span>
        {/* the fuel line: metered truth against the hard cap, est. labeled apart */}
        <div className="basis-full">
          <div className="h-1.5 w-full bg-[#e7e3d8]">
            <div className="h-full bg-kept" style={{ width: `${fuelFrac * 100}%` }} />
          </div>
          <div className="mt-1 font-mono text-[12px] tabular-nums text-faint">
            ${state.membrane.meteredUsd.toFixed(4)} metered of ${state.membrane.fuelCapUsd.toFixed(2)} cap
            {state.membrane.hardStop ? ' · hard stop' : ''}
            {state.membrane.estSpentUsd > 0 ? ` · $${state.membrane.estSpentUsd.toFixed(4)} est. pending (labeled)` : ''}
          </div>
        </div>
        {canStart && severed.length > 0 ? (
          <p className="basis-full text-[12.5px] leading-snug text-warn" data-testid="brain-only-note">
            brain-only — {severed.join(', ')} not connected: it reasons and drafts, touches nothing real
          </p>
        ) : null}
        {editedAway !== null ? (
          <p className="basis-full text-[12.5px] text-warn" data-testid="edited-away">
            saved as a new spec — this run continues under its frozen spec.{' '}
            <a href={`/lab/harness/${editedAway}`} className="text-accent underline">open the new worker →</a>
          </p>
        ) : null}
      </div>

      {/* ================= the question card ================= */}
      {mode === 'awaiting-human' && state.glow.pendingQuestion !== null ? (
        <div className="mt-4 border-2 border-warn bg-white px-6 py-5" data-testid="form-check-in">
          <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-warn">
            it&rsquo;s asking — the run is paused until you answer
          </div>
          <p className="mt-2 text-[16px] leading-relaxed text-ink">{state.glow.pendingQuestion}</p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (answer.length > 0) void sendAnswer(); }}
          >
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="yes approves · no refuses · or say what to change"
              className="w-full border border-[#c4bfb2] bg-white px-3 py-2 font-mono text-[13.5px] text-ink placeholder:text-faint focus:border-warn focus:outline-none"
              data-testid="form-answer"
            />
            <button
              type="submit"
              disabled={answer.length === 0}
              className="bg-ink px-5 py-2 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-30"
              data-testid="form-answer-send"
            >
              Answer
            </button>
          </form>
          <p className="mt-2 font-mono text-[12px] text-faint">every answer lands on the permission record as evidence</p>
          {answerError && <p className="mt-1 text-[12.5px] text-refuse" data-testid="answer-error">{answerError}</p>}
        </div>
      ) : null}

      {/* ================= X3: the finish, felt ================= */}
      {run !== null && TERMINAL.has(run.state) ? (
        <div
          className={`mt-4 border px-6 py-4 ${run.state === 'completed' ? 'border-accent/60 bg-[#fbfaf7]' : 'border-warn bg-[#fbfaf7]'}`}
          data-testid="terminal-banner"
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 font-mono text-[13px]">
            <span className={run.state === 'completed' ? 'font-semibold text-accent' : 'font-semibold text-warn'}>
              {run.state === 'completed'
                ? run.deliverable != null ? 'check complete · deliverable filed' : 'run complete'
                : run.state === 'killed-budget' ? 'stopped at the spending cap — the hard stop did its job'
                : run.state === 'failed' ? `failed — ${run.stateReason ?? 'see the record'}`
                : 'stopped by the operator'}
            </span>
            <span className="text-soft">${run.cost.meteredUsd.toFixed(4)} metered</span>
            {typeof run.premiumUsd === 'number' && run.premiumUsd > run.cost.meteredUsd ? (
              <span className="text-kept" data-testid="routing-dividend">
                the best scorer on every step would have cost ${run.premiumUsd.toFixed(2)}
              </span>
            ) : null}
            {run.judge != null && 'overall' in run.judge ? (
              <span className="text-ink" data-testid="judge-chip">
                scored {run.judge.overall}/10 against your bar
                <span className="text-faint"> · advisory{run.judge.calibrated ? '' : ' (uncalibrated)'}</span>
              </span>
            ) : null}
            <button
              type="button"
              disabled={verify.busy}
              onClick={() => {
                setVerify({ busy: true, result: null });
                void fetch(`/api/lab/runs/${runId}/verify`, { method: 'POST' })
                  .then((r) => r.json())
                  .then((b: { ok?: boolean; steps?: number; divergences?: number }) =>
                    setVerify({
                      busy: false,
                      result: b.ok
                        ? `record verified: all ${b.steps} steps derive cleanly from the record — self-consistent and replayable`
                        : `record shows ${b.divergences} divergence(s) — this run's record does not fully derive`,
                    }),
                  )
                  .catch(() => setVerify({ busy: false, result: 'verification unavailable' }));
              }}
              className="border border-[#c4bfb2] px-2.5 py-1 text-[12px] text-soft hover:border-accent hover:text-accent disabled:opacity-40"
              data-testid="verify-record"
            >
              {verify.busy ? 'replaying…' : 'verify this record'}
            </button>
          </div>
          {verify.result !== null ? (
            <p className="mt-1.5 font-mono text-[12px] text-soft" data-testid="verify-result">{verify.result}</p>
          ) : null}
          {run.judge != null && 'overall' in run.judge ? (
            <div className="mt-2 grid gap-0.5 font-mono text-[12px] text-faint" data-testid="judge-criteria">
              {run.judge.criteria.map((c) => (
                <span key={c.name}>{c.score}/10 · {c.name}{c.note !== '' ? ` — ${c.note}` : ''}</span>
              ))}
              {run.judge.rationale !== '' ? <span className="text-soft">{run.judge.rationale}</span> : null}
            </div>
          ) : null}
          {run.judge != null && 'error' in run.judge ? (
            <p className="mt-1.5 font-mono text-[12px] text-warn">judge: {run.judge.error}</p>
          ) : null}
        </div>
      ) : null}

      {/* ================= P-3: the first-run recap (once, ever) ================= */}
      {showRecap && run !== null && run.state === 'completed' ? (
        <div className="mt-4 border border-accent/50 bg-white px-6 py-4" data-testid="first-run-recap">
          <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-accent">what you just saw</div>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-soft">
            {run.steps.length} recorded steps · each model call routed by its kind of work ·{' '}
            <b className="text-ink">${run.cost.meteredUsd.toFixed(4)}</b> spent, capped by law ·
            the record is replayable — press &ldquo;verify this record&rdquo; above to prove it ·
            autonomy: <b className="text-ink">zero</b> — earned from evidence, never given.
          </p>
          <button type="button" onClick={() => setShowRecap(false)} className="mt-2 text-[12px] text-faint underline hover:text-soft">
            got it
          </button>
        </div>
      ) : null}

      {/* ================= the deliverable (P1: the mouth) ================= */}
      {run?.deliverable != null ? (
        <div className="mt-4">
          <BriefView brief={run.deliverable.brief} />
        </div>
      ) : null}

      {/* ================= the task ledger (X2) ================= */}
      {run?.plan != null && run.plan.length > 0 ? (
        <section className={`${CARD} mt-4 px-5 py-4`} data-testid="task-ledger">
          <div className={EYEBROW}>
            the plan · the worker&rsquo;s durable task ledger ·{' '}
            {run.plan.filter((t) => t.status === 'done').length}/{run.plan.length} done
          </div>
          <ul className="mt-2 grid gap-1 font-mono text-[13px]">
            {run.plan.map((t) => (
              <li key={t.id} className="flex items-baseline gap-2">
                <span
                  className={
                    t.status === 'done'
                      ? 'text-kept'
                      : t.status === 'blocked'
                        ? 'text-refuse'
                        : t.status === 'doing'
                          ? 'text-accent'
                          : 'text-faint'
                  }
                >
                  {t.status === 'done' ? '☑' : t.status === 'blocked' ? '⚠' : t.status === 'doing' ? '◐' : '☐'}
                </span>
                <span className={t.status === 'done' ? 'text-soft line-through decoration-[#c4bfb2]' : 'text-ink'}>
                  {t.title}
                </span>
                {t.note !== undefined ? <span className="text-faint">— {t.note}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ================= the work + the worker ================= */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ---- the work feed ---- */}
        <section className={`${CARD} px-5 py-4 lg:col-span-2`}>
          <div className={EYEBROW}>
            the work · the durable step record{state.glow.simulated ? ' · contains simulated steps' : ''}
          </div>
          {steps.length === 0 ? (
            <p className="py-6 font-mono text-[12px] text-faint">
              {runId === null
                ? 'no run attached — press “run a supervised trial” to watch it work here'
                : 'waiting for the first step…'}
            </p>
          ) : (
            <ol ref={feedRef} className="mt-1 max-h-[520px] overflow-y-auto pr-1" data-testid="narration">
              {steps.map((s) => <FeedRow key={s.seq} step={s} />)}
            </ol>
          )}
        </section>

        {/* ---- the anatomy rail: what this worker IS ---- */}
        <div className="grid content-start gap-4">
          <section className={`${CARD} px-5 py-4`}>
            <div className={EYEBROW}>mission · {state.membrane.missionKind === 'task' ? 'one-off task' : 'standing'}</div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink">{state.identity.goal}</p>
            {spec.mission.kind === 'task' ? (
              <p className="mt-1.5 font-mono text-[12px] text-faint">done when: {spec.mission.doneDefinition}</p>
            ) : null}
          </section>

          <section className={`${CARD} px-5 py-4`}>
            <div className={EYEBROW}>brain · chosen from live evidence</div>
            <p className="mt-1.5 font-mono text-[12.5px] text-ink">
              {state.core.policyType} · <code>{state.core.strategy8}</code>
            </p>
            {views.length > 1 && role !== 'viewer' ? (
              <div className="mt-2 grid gap-1" data-testid="dial-panel">
                {views.map((v) => {
                  const current = v.strategyHash?.slice(0, 8) === state.core.strategy8;
                  return (
                    <button
                      key={v.position.qualityIndex}
                      disabled={busy || current}
                      onClick={() => void moveDial(v.position.qualityIndex)}
                      className={`border px-2.5 py-1.5 text-left font-mono text-[12px] ${current ? 'border-accent text-accent' : 'border-[#d9d5cb] text-soft hover:border-accent'}`}
                    >
                      q {v.quality?.toFixed(2)} · ${v.costPer1K?.toFixed(3)}/1K · {v.latencyP95}ms{current ? ' ← current' : ''}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className={`${CARD} px-5 py-4`}>
            <div className={EYEBROW}>budget</div>
            <p className="mt-1.5 font-mono text-[12.5px] text-ink">
              ${state.membrane.fuelCapUsd.toFixed(2)} cap per {state.membrane.missionKind === 'task' ? 'run' : 'check'}
              {state.membrane.hardStop ? ' · hard stop' : ''}
            </p>
            {role !== 'viewer' ? <WorthEditor busy={busy} onApply={applyEdit} /> : null}
          </section>

          <section className={`${CARD} px-5 py-4`}>
            <div className={EYEBROW}>accounts</div>
            {state.filaments.length === 0 ? (
              <p className="mt-1.5 font-mono text-[12px] text-faint">none — this worker only thinks and writes</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {state.filaments.map((f) => (
                  <span
                    key={f.id}
                    className={`${CHIP} ${f.connection === 'connected' ? 'border-kept text-kept' : f.connection === 'revoked' ? 'border-refuse text-refuse' : 'border-[#c4bfb2] text-soft'}`}
                  >
                    {f.id} · {f.connection}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className={`${CARD} px-5 py-4`}>
            <div className={EYEBROW}>rules · {state.membrane.laminations}</div>
            {spec.rules.length > 0 ? (
              <ul className="mt-1.5 grid gap-1 text-[12.5px] leading-snug text-soft">
                {spec.rules.map((r, i) => <li key={i}>· {r}</li>)}
              </ul>
            ) : (
              <p className="mt-1.5 font-mono text-[12px] text-faint">none yet — a rule is a sentence it must never break</p>
            )}
            {role !== 'viewer' ? <RuleEditor busy={busy} onApply={applyEdit} /> : null}
          </section>

          <section className={`${CARD} px-5 py-4`} data-testid="memory-panel">
            <div className={EYEBROW}>memory {state.core.memoryEnabled ? '' : '· off for one-off tasks'}</div>
            {memory.entries.length === 0 ? (
              <p className="mt-1.5 font-mono text-[12px] text-faint">nothing remembered yet</p>
            ) : (
              memory.entries.map((e) => (
                <div key={e.key} className="mt-1.5 border-t border-dashed border-[#d9d5cb] pt-1.5 text-[12.5px] text-soft first:border-0 first:pt-0">
                  <code className="text-ink">{e.key}</code>: {e.rendered.slice(0, 140)}
                  {role !== 'viewer' ? (
                    <button
                      className="ml-2 text-[12px] text-refuse underline"
                      onClick={() => {
                        if (!window.confirm(`Delete '${e.key}' permanently? No undo.`)) return;
                        void fetch(`/api/lab/memory/${harness.harnessHash}/${encodeURIComponent(e.key)}`, { method: 'DELETE' })
                          .then(() => refetchHarness(harness.harnessHash));
                      }}
                    >
                      delete
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </section>
        </div>
      </div>

      {/* ================= provenance: the audit map, on demand ================= */}
      <details className="mt-4" data-testid="audit-readout">
        <summary className="cursor-pointer font-mono text-[12px] uppercase tracking-[0.13em] text-faint hover:text-accent">
          every value on this console is a live parameter — open the audit map
        </summary>
        <div className={`${CARD} mt-2 px-5 py-4 font-mono text-[12px]`}>
          {Object.entries(AUDIT).map(([path, row]) => (
            <div key={path} className="border-t border-dashed border-[#d9d5cb] py-1.5 first:border-0">
              <span className="text-faint">{path}</span>{' '}
              <span className="text-ink">{JSON.stringify(leafValue(state, path)) ?? '—'}</span>
              <div className="text-[11px] text-faint opacity-70">{row.sourcePath}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function RuleEditor({ busy, onApply }: { busy: boolean; onApply: (ops: unknown[]) => Promise<boolean> }) {
  const [rule, setRule] = useState('');
  return (
    <div className="mt-2 flex gap-1.5">
      <input
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        placeholder="never email anyone outside the company"
        className="w-full border border-[#d9d5cb] bg-white px-2 py-1 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        data-testid="edit-rule"
      />
      <button
        disabled={busy || rule.length === 0}
        onClick={() => void onApply([{ op: 'add-rule', rule }]).then((ok) => ok && setRule(''))}
        className="border border-[#c4bfb2] px-2.5 text-[12px] text-soft hover:border-accent hover:text-accent disabled:opacity-40"
        data-testid="edit-rule-add"
      >
        add
      </button>
    </div>
  );
}

function WorthEditor({ busy, onApply }: { busy: boolean; onApply: (ops: unknown[]) => Promise<boolean> }) {
  const [worth, setWorth] = useState('');
  return (
    <div className="mt-2 flex gap-1.5">
      <input
        value={worth}
        onChange={(e) => setWorth(e.target.value)}
        placeholder="new worth in $ — the cap re-derives"
        className="w-full border border-[#d9d5cb] bg-white px-2 py-1 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        data-testid="edit-worth"
      />
      <button
        disabled={busy || !(Number(worth) > 0)}
        onClick={() => void onApply([{ op: 'set-worth', worthUsd: Number(worth) }]).then((ok) => ok && setWorth(''))}
        className="border border-[#c4bfb2] px-2.5 text-[12px] text-soft hover:border-accent hover:text-accent disabled:opacity-40"
      >
        set
      </button>
    </div>
  );
}

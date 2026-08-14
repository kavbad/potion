'use client';
// THE DERIVED FORM — the harness/run pages' primary surface (Step 9).
//
// All derivation, auditing, and drawing live in @potion/lab-form; this
// component owns only the browser concerns: the poll loop (the SAME 1.5s
// cadence the Step 8 run page used — no new server load), the zoom
// control (clamped at MID; Step 16 owns deeper), the DOM label/panel
// overlay (the accessible surface), and the honesty plumbing — pulses come
// ONLY from diffFormState, staleness from the real poll clock, degrade
// from measured fps, SIMULATED from the data.
//
// The container carries SSR-visible data attributes derived from the same
// DTOs (the walkthrough's proof surface for live re-render).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUDIT,
  DegradeController,
  ZOOM,
  clampZoom,
  deriveFormState,
  diffFormState,
  draw,
  THEME,
  type DrawGeometry,
  type FormState,
  type HarnessDto,
  type LivePulse,
  type MemoryDto,
  type RunDto,
} from '@potion/lab-form';

const POLL_MS = 1500;
const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);

const card: React.CSSProperties = {
  background: '#0e121bd9', border: '1px solid #1c2230', borderRadius: 6, padding: 10,
  font: '12px/1.5 ui-monospace, Menlo, monospace', color: '#c9d2e0',
};

function leafValue(state: FormState, path: string): unknown {
  let v: unknown = state;
  for (const part of path.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
  return v;
}

export function LabFormView({
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
  /** Which page owns the view — the RUN page never rewrites its URL and
   * never swaps the harness under a live run (review findings). */
  surface: 'harness' | 'run';
}) {
  const [harness, setHarness] = useState(initialHarness);
  const [memory, setMemory] = useState(initialMemory);
  const [run, setRun] = useState<RunDto | null>(initialRun ?? null);
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [zoom, setZoom] = useState(0);
  const [answer, setAnswer] = useState('');
  const [panel, setPanel] = useState<'none' | 'dial' | 'edit' | 'memory'>('none');
  const [busy, setBusy] = useState(false);

  const lastPollAt = useRef<number | null>(initialRun ? Date.now() : null);
  const prevState = useRef<FormState | null>(null);
  const pulses = useRef<LivePulse[]>([]);
  const beads = useRef(0);
  const pulseAngle = useRef(0);
  const degrade = useRef<DegradeController | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geomRef = useRef<DrawGeometry | null>(null);
  /** Guards a still-in-flight poll of a PREVIOUS run from committing after
   * a run swap (review finding: the startTrial race). */
  const runEpoch = useRef(0);
  const [derivedTick, setDerivedTick] = useState(0);

  const terminal = run !== null && TERMINAL.has(run.state);

  // Base derivation. derivedTick forces a re-derivation each staleness
  // tick — the poll-age clock is an AUDITED input. The clock keys on the
  // POLL TARGET (runId), not on a resolved run: an accepted trial that
  // never successfully polls must age into 'disconnected', never sit as a
  // calm config view (review finding). A terminal run derives 'settled'
  // inside deriveFormState regardless of age.
  const state = useMemo(() => {
    void derivedTick;
    const age =
      runId === null || lastPollAt.current === null
        ? null
        : Date.now() - lastPollAt.current;
    return deriveFormState(harness, memory, run, age);
  }, [harness, memory, run, runId, derivedTick]);

  // Honesty plumbing: pulses come ONLY from the diff of consecutive
  // derivations; identical polls emit nothing. The FIRST derivation seeds
  // the baseline WITHOUT emitting — opening a page is not events arriving
  // (review finding: no mount burst replaying a finished run's history).
  useEffect(() => {
    if (prevState.current === null) {
      prevState.current = state;
      return;
    }
    const ev = diffFormState(prevState.current, state);
    const now = performance.now();
    for (const p of ev.pulses) {
      pulseAngle.current += 1;
      pulses.current.push({
        event: p, bornMs: now, metered: !p.hollow,
        angle: -Math.PI / 2 + ((pulseAngle.current % 7) - 3) * 0.28,
      });
    }
    for (const r of ev.retints) {
      const live = pulses.current.find((p) => p.event.seq === r.seq);
      if (live) live.metered = true;
    }
    beads.current += ev.anomalies.length;
    prevState.current = state;
  }, [state]);

  // The poll — the run page's existing cadence, nothing new. Epoch-guarded
  // against late responses for a swapped-away run. A TERMINAL run gets one
  // final poll and then neither polling nor a staleness clock: its data is
  // final and 'settled' (review finding: a completed run must never age
  // into 'VIEW DISCONNECTED').
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
        /* the staleness ring reports this honestly — no retry theater */
      }
    };
    void poll();
    if (terminal) return;
    const t = setInterval(() => void poll(), POLL_MS);
    const staleTick = setInterval(() => setDerivedTick((n) => n + 1), 1000);
    return () => { clearInterval(t); clearInterval(staleTick); };
  }, [runId, terminal]);

  // ONE persistent render loop (empty deps): state/zoom flow through refs
  // so the fps sampling window SURVIVES data updates — with [state, zoom]
  // deps the 1s window reset on every poll/tick and degrade could never
  // fire under load (review finding: sampling starvation).
  const stateRef = useRef(state);
  stateRef.current = state;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    degrade.current ??= new DegradeController(
      matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    let raf = 0;
    let frames = 0;
    let fpsWindow = performance.now();
    const loop = (tNow: number) => {
      frames += 1;
      if (tNow - fpsWindow >= 1000) {
        if (degrade.current!.sample(frames, tNow)) {
          // a recorded, visible transition — logged once per change
          console.info(`[lab-form] degrade → ${degrade.current!.mode}`);
        }
        frames = 0;
        fpsWindow = tNow;
      }
      const cv = canvasRef.current;
      if (cv) {
        const dpr = Math.min(2, devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        const ctx = cv.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          pulses.current = pulses.current.filter((p) => tNow - p.bornMs < THEME.pulseLifeMs);
          geomRef.current = draw(ctx, stateRef.current, {
            w, h, zoom: zoomRef.current, tNowMs: tNow,
            livePulses: pulses.current,
            anomalyBeadCount: beads.current,
            degrade: degrade.current!.mode,
          });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const labelO = Math.max(0, Math.min(1, (zoom - ZOOM.FAR_MAX) / (ZOOM.MID_MIN - ZOOM.FAR_MAX)));

  // ---- actions through the REAL routes ----
  const refetchHarness = useCallback(async (hash: string) => {
    const res = await fetch(`/api/lab/harnesses/${hash}`);
    if (res.ok) {
      setHarness((await res.json()) as HarnessDto);
      const mem = await fetch(`/api/lab/memory/${hash}`);
      if (mem.ok) setMemory((await mem.json()) as MemoryDto);
      // URL rewriting ONLY on the harness surface and only when the
      // content hash actually moved — the run page's URL is the run's
      // identity and is never destroyed (review finding).
      if (surface === 'harness' && hash !== initialHarness.harnessHash) {
        history.replaceState(null, '', `/lab/harness/${hash}`);
      }
    }
  }, [surface, initialHarness.harnessHash]);

  /** A live (non-terminal) run is FROZEN to its own spec — swapping the
   * edited harness under it would rescale the fuel arc against the wrong
   * cap (review finding). Edits still land; the view says where. */
  const liveRunAttached = runId !== null && (run === null || !TERMINAL.has(run.state));
  const [editedAway, setEditedAway] = useState<string | null>(null);

  const applyEdit = useCallback(async (ops: unknown[]) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/lab/harnesses/${harness.harnessHash}/edit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      const body = (await res.json()) as { ok?: boolean; harnessHash?: string; unchanged?: boolean };
      if (res.ok && body.harnessHash && body.unchanged === false) {
        if (liveRunAttached) {
          setEditedAway(body.harnessHash); // the run stays on its frozen spec
        } else {
          await refetchHarness(body.harnessHash); // live re-render: the REAL path
        }
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
      const body = (await res.json()) as { ok?: boolean; harnessHash?: string };
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
        runEpoch.current += 1; // a late poll of the OLD run can never commit
        pulses.current = []; beads.current = 0; prevState.current = null;
        lastPollAt.current = Date.now();
        setEditedAway(null);
        setRun(null);
        setRunId(body.runId);
      }
    } finally {
      setBusy(false);
    }
  }, [harness.harnessHash]);

  const sendAnswer = useCallback(async () => {
    if (runId === null) return;
    const res = await fetch(`/api/lab/runs/${runId}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    if (res.status === 202) setAnswer('');
  }, [runId, answer]);

  const views = harness.dial.brain.views ?? [];
  const feasibleViews = views.filter((v) => v.feasible);

  return (
    <div
      data-testid="lab-form"
      data-harness-hash={harness.harnessHash}
      data-mission-kind={state.membrane.missionKind}
      data-severed={state.filaments.filter((f) => f.severed).length}
      data-tint={state.signatureTint}
      data-run-state={state.glow.mode}
      data-laminations={state.membrane.laminations}
      style={{ position: 'relative', height: '82vh', background: '#0a0c11', borderRadius: 8, overflow: 'hidden' }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

      {/* zoom rail with the Step 16 terminal stop */}
      <div style={{ ...card, position: 'absolute', left: 12, top: 12, width: 190 }}>
        <div style={{ fontSize: 10, letterSpacing: '.1em', color: '#6b7688' }}>ZOOM — FAR ⇢ MID</div>
        <input
          type="range" min={0} max={1} step={0.01} value={zoom}
          onChange={(e) => setZoom(clampZoom(Number(e.target.value)))}
          style={{ width: '100%', accentColor: state.signatureTint }}
          data-testid="zoom"
        />
        <div style={{ fontSize: 10, color: '#6b7688', borderTop: '1px dashed #1c2230', marginTop: 6, paddingTop: 5 }}>
          ⛔ ends at mid — schematic &amp; the file arrive with the bench (Step 16)
        </div>
      </div>

      {/* run controls — the real routes, always visible */}
      <div style={{ ...card, position: 'absolute', right: 12, top: 12, width: 250 }}>
        <div style={{ fontSize: 10, letterSpacing: '.1em', color: '#6b7688' }}>
          {harness.name} · {state.glow.mode}
        </div>
        {state.glow.mode === 'awaiting-human' && state.glow.pendingQuestion !== null ? (
          <div style={{ marginTop: 6 }} data-testid="form-check-in">
            <div>{state.glow.pendingQuestion}</div>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} style={{ width: '100%', marginTop: 4 }} data-testid="form-answer" />
            <button onClick={() => void sendAnswer()} disabled={answer.length === 0} data-testid="form-answer-send">answer</button>
          </div>
        ) : null}
        {runId === null || (run !== null && TERMINAL.has(run.state)) ? (
          <button onClick={() => void startTrial()} disabled={busy} data-testid="form-start-trial" style={{ marginTop: 6 }}>
            run a trial
          </button>
        ) : (
          <button
            onClick={() => runId !== null && void fetch(`/api/lab/runs/${runId}/kill`, { method: 'POST' })}
            style={{ marginTop: 6 }} data-testid="form-kill"
          >
            stop this run
          </button>
        )}
        {run !== null && TERMINAL.has(run.state) ? (
          <a href={`/lab/run/${runId}/report`} style={{ display: 'block', marginTop: 6, color: '#8ecfff' }} data-testid="form-report-link">
            open the report →
          </a>
        ) : null}
        {editedAway !== null ? (
          <div style={{ marginTop: 6, fontSize: 11, color: '#d9c26a' }} data-testid="edited-away">
            saved as a new spec — this run continues under its frozen spec.{' '}
            <a href={`/lab/harness/${editedAway}`} style={{ color: '#8ecfff' }}>open the new harness →</a>
          </div>
        ) : null}
        <div style={{ marginTop: 6, fontSize: 11, color: '#6b7688' }}>
          metered ${state.membrane.meteredUsd.toFixed(4)}
          {state.membrane.estSpentUsd > 0 ? <> · est ${state.membrane.estSpentUsd.toFixed(4)} <i>(labeled)</i></> : null}
        </div>
      </div>

      {/* anatomy panels (mid zoom) — the accessible surface, real edit paths */}
      <div style={{ position: 'absolute', left: 12, bottom: 12, right: 12, display: 'flex', gap: 10, opacity: labelO, pointerEvents: labelO > 0.4 ? 'auto' : 'none', alignItems: 'flex-end' }}>
        <div style={{ ...card, width: 300, maxHeight: '38vh', overflow: 'auto' }} data-testid="audit-readout">
          <div style={{ fontSize: 10, letterSpacing: '.1em', color: '#6b7688', marginBottom: 6 }}>PIXEL → PARAMETER (LIVE)</div>
          {Object.entries(AUDIT).map(([path, row]) => (
            <div key={path} style={{ borderTop: '1px solid #161c29', padding: '3px 0' }}>
              <span style={{ color: '#6b7688' }}>{path}</span>{' '}
              <span>{JSON.stringify(leafValue(state, path)) ?? '—'}</span>
              <div style={{ fontSize: 10, color: '#3b4354' }}>{row.sourcePath}</div>
            </div>
          ))}
        </div>
        <div style={{ ...card, flex: 1 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['dial', 'edit', 'memory'] as const).map((p) => (
              <button key={p} onClick={() => setPanel(panel === p ? 'none' : p)} data-testid={`panel-${p}`} style={{ color: panel === p ? '#dff6f3' : undefined }}>
                {p}
              </button>
            ))}
          </div>
          {panel === 'dial' ? (
            <div style={{ marginTop: 8 }} data-testid="dial-panel">
              {feasibleViews.map((v) => (
                <button key={v.position.qualityIndex} disabled={busy || role === 'viewer'} onClick={() => void moveDial(v.position.qualityIndex)}>
                  rung {v.position.qualityIndex}: q {v.quality?.toFixed(2)} · ${v.costPer1K?.toFixed(3)}/1K · {v.latencyP95}ms
                  {v.strategyHash?.slice(0, 8) === state.core.strategy8 ? ' ← current' : ''}
                </button>
              ))}
            </div>
          ) : null}
          {panel === 'edit' ? <EditPanel busy={busy} onApply={applyEdit} state={state} /> : null}
          {panel === 'memory' ? (
            <div style={{ marginTop: 8 }} data-testid="memory-panel">
              {memory.entries.length === 0 ? <div>nothing remembered yet</div> : null}
              {memory.entries.map((e) => (
                <div key={e.key} style={{ borderTop: '1px solid #161c29', padding: '3px 0' }}>
                  <code>{e.key}</code>: {e.rendered.slice(0, 120)}
                  <button
                    onClick={() => {
                      if (!window.confirm(`Delete '${e.key}' permanently? No undo.`)) return;
                      void fetch(`/api/lab/memory/${harness.harnessHash}/${encodeURIComponent(e.key)}`, { method: 'DELETE' })
                        .then(() => refetchHarness(harness.harnessHash));
                    }}
                  >
                    delete
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EditPanel({ busy, onApply, state }: {
  busy: boolean;
  onApply: (ops: unknown[]) => Promise<boolean>;
  state: FormState;
}) {
  const [rule, setRule] = useState('');
  const [worth, setWorth] = useState('');
  const [power, setPower] = useState('');
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 6 }} data-testid="edit-panel">
      <div>
        rule: <input value={rule} onChange={(e) => setRule(e.target.value)} size={30} data-testid="edit-rule" />
        <button disabled={busy || rule.length === 0} data-testid="edit-rule-add"
          onClick={() => void onApply([{ op: 'add-rule', rule }]).then((ok) => ok && setRule(''))}>
          add ({state.membrane.laminations} now)
        </button>
      </div>
      <div>
        worth $: <input value={worth} onChange={(e) => setWorth(e.target.value)} size={8} data-testid="edit-worth" />
        <button disabled={busy || !(Number(worth) > 0)}
          onClick={() => void onApply([{ op: 'set-worth', worthUsd: Number(worth) }])}>
          set (fuel re-derives → ${state.membrane.fuelCapUsd})
        </button>
      </div>
      <div>
        superpower: <input value={power} onChange={(e) => setPower(e.target.value)} size={16} />
        <button disabled={busy || power.length < 2}
          onClick={() => void onApply([{ op: 'declare-superpower', id: power }]).then((ok) => ok && setPower(''))}>
          declare (connects in a later step)
        </button>
      </div>
    </div>
  );
}

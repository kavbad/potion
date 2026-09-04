'use client';
// THE WORKER PAGE AS A CONVERSATION (2026-09-03, operator: "mostly a chat
// interface, but with the workbench, and a pane to access settings").
//
// The same durable record, read the way people already know how to read:
// the job is the first message, the worker's narrated steps are its
// replies, and ONE composer at the bottom does what the run's state means:
//   parked   → the ANSWER channel (the pore's monopoly on authorization)
//   running  → the STEER channel (guidance, never authorization)
//   idle     → starts a run, carrying anything attached
// Three real routes behind one input — no new authority, no blurred line
// between answering and steering (the chip above the box says which one).
//
// The bench (files, live output) sits beside it, and settings are a pane,
// not a page: what it is, what it may touch, what it costs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { HarnessDto, RunDto } from '@potion/lab-form';
import { LabWorkbench } from './lab-workbench';

const POLL_MS = 1500;
const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);
const MONO = 'font-mono text-[12px]';

function stateTone(state: string | undefined): { label: string; cls: string } {
  switch (state) {
    case 'running':
    case 'pending':
      return { label: 'working', cls: 'text-accent' };
    case 'awaiting-human':
      return { label: 'waiting for you', cls: 'text-warn' };
    case 'completed':
      return { label: 'done', cls: 'text-kept' };
    case 'failed':
    case 'killed-budget':
    case 'killed-operator':
      return { label: state === 'failed' ? 'failed' : 'stopped', cls: 'text-refuse' };
    default:
      return { label: 'idle', cls: 'text-faint' };
  }
}

/** One turn in the conversation. A step the narrator marked hidden carries
 * no information for a reader and is simply not a turn. */
function Turn({ step }: { step: NonNullable<RunDto['steps']>[number] }) {
  if (step.hidden === true) return null;
  const isAsk = step.kind === 'check-in';
  const body = step.detail ?? (step.title === undefined ? step.excerpt : undefined);
  return (
    <div className={`px-1 py-3 ${isAsk ? '' : ''}`} data-testid={`turn-${step.seq}`}>
      <div className="flex items-baseline gap-2">
        <span className={`${MONO} tabular-nums text-faint`} suppressHydrationWarning>
          {new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        {step.gate?.decision === 'allow' ? (
          <span className={`${MONO} text-accent`}>ran alone · earned</span>
        ) : null}
        {step.gate?.decision === 'block' ? (
          <span className={`${MONO} text-refuse`}>barred by constitution</span>
        ) : null}
        {step.kind === 'model' && step.costLabel === 'metered' ? (
          <span className={`${MONO} tabular-nums text-faint`}>${(step.meteredCostUsd ?? 0).toFixed(4)}</span>
        ) : null}
      </div>
      {step.title !== undefined && step.kind !== 'model' ? (
        <p className="mt-0.5 text-[14px] font-medium leading-relaxed text-ink">{step.title}</p>
      ) : null}
      {body !== undefined ? (
        step.detailKind === 'code' ? (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap border-l-2 border-line pl-3 font-mono text-[12px] leading-relaxed text-soft">
            {body}
          </pre>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink">{body}</p>
        )
      ) : null}
      {step.steers !== undefined && step.steers.length > 0
        ? step.steers.map((t, i) => (
            <p key={i} className="mt-1 border-l-2 border-accent/60 pl-3 text-[13.5px] text-accent">
              you: {t}
            </p>
          ))
        : null}
    </div>
  );
}

function SettingsPane({ harness }: { harness: HarnessDto }) {
  const spec = harness.spec;
  if (spec === null) return null;
  const rows: Array<[string, React.ReactNode]> = [
    ['job', spec.mission.goal],
    ...(spec.mission.kind === 'task' && spec.mission.doneDefinition !== undefined
      ? ([['done when', spec.mission.doneDefinition]] as Array<[string, React.ReactNode]>)
      : []),
    ['budget', `$${spec.fuel.maxUsdPerRun.toFixed(2)} per run · hard stop`],
    [
      'may touch',
      harness.superpowers.length === 0 ? (
        'nothing external — it thinks and writes'
      ) : (
        <span>
          {harness.superpowers.map((s, i) => (
            <span key={s.id}>
              {i > 0 ? ', ' : ''}
              {s.id}
              <span className={s.status === 'connected' ? 'text-kept' : 'text-warn'}> ({s.status})</span>
            </span>
          ))}
        </span>
      ),
    ],
    ['memory', spec.memory.enabled ? 'keeps notes between runs' : 'each run starts fresh'],
    ...(spec.rules.length > 0
      ? ([['never', spec.rules.join(' · ')]] as Array<[string, React.ReactNode]>)
      : []),
  ];
  return (
    <dl className="space-y-3" data-testid="settings-pane">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className={`${MONO} uppercase tracking-[0.12em] text-faint`}>{k}</dt>
          <dd className="mt-0.5 text-[13.5px] leading-relaxed text-ink">{v}</dd>
        </div>
      ))}
      <div className="pt-1">
        <Link
          href={`/lab/harness/${harness.harnessHash}`}
          className={`${MONO} text-soft underline decoration-line underline-offset-4 hover:text-accent`}
          data-testid="open-machinery"
        >
          all settings, machinery and permission record →
        </Link>
      </div>
    </dl>
  );
}

export function LabChat({
  harness: initialHarness,
  initialRunId,
  initialRun,
}: {
  harness: HarnessDto;
  initialRunId: string | null;
  initialRun: RunDto | null;
}) {
  const [harness] = useState(initialHarness);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [run, setRun] = useState<RunDto | null>(initialRun);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<{ name: string; contentBase64: string; size: number }>>([]);
  const [showSettings, setShowSettings] = useState(true);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const seen = useRef(0);

  const state = run?.state;
  const terminal = run === null || TERMINAL.has(state ?? '');
  const parked = state === 'awaiting-human';
  const live = run !== null && !TERMINAL.has(state ?? '');
  const tone = stateTone(state);

  // The record poll — the same 1.5s read the console has always used.
  useEffect(() => {
    if (runId === null) return;
    let stale = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/lab/runs/${runId}`);
        if (res.ok && !stale) setRun((await res.json()) as RunDto);
      } catch {
        /* the status line tells the truth on the next tick */
      }
    };
    void poll();
    if (terminal) return;
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      stale = true;
      clearInterval(t);
    };
  }, [runId, terminal]);

  // Follow the conversation as it grows.
  const turns = useMemo(() => (run?.steps ?? []).filter((s) => s.hidden !== true), [run]);
  useEffect(() => {
    if (turns.length > seen.current && threadRef.current !== null) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
    seen.current = turns.length;
  }, [turns.length]);

  const pickFiles = useCallback(async (list: FileList | null) => {
    if (list === null) return;
    const picked: Array<{ name: string; contentBase64: string; size: number }> = [];
    for (const f of Array.from(list).slice(0, 4)) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      picked.push({ name: f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120), contentBase64: btoa(bin), size: f.size });
    }
    setAttachments(picked);
  }, []);

  /** ONE composer, three real channels — chosen by what the run IS. */
  const send = useCallback(async () => {
    const body = text.trim();
    setBusy(true);
    setNote(null);
    try {
      if (parked && runId !== null) {
        if (body === '') return;
        const res = await fetch(`/api/lab/runs/${runId}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: body }),
        });
        if (res.status === 202) setText('');
        else {
          const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          setNote(b?.error?.message ?? `could not send (${res.status})`);
        }
        return;
      }
      if (live && runId !== null) {
        if (body === '') return;
        const res = await fetch(`/api/lab/runs/${runId}/steer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: body }),
        });
        if (res.ok) setText('');
        else {
          const b = (await res.json().catch(() => null)) as { reason?: string } | null;
          setNote(b?.reason ?? `could not steer (${res.status})`);
        }
        return;
      }
      // Idle: start a run. Anything attached rides it.
      const res = await fetch('/api/lab/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harnessHash: harness.harnessHash,
          ...(attachments.length > 0
            ? { attachments: attachments.map(({ name, contentBase64 }) => ({ name, contentBase64 })) }
            : {}),
        }),
      });
      const b = (await res.json().catch(() => null)) as { runId?: string; error?: { message?: string } } | null;
      if (res.status === 202 && b?.runId) {
        setAttachments([]);
        setText('');
        seen.current = 0;
        setRun(null);
        setRunId(b.runId);
      } else setNote(b?.error?.message ?? `could not start (${res.status})`);
    } finally {
      setBusy(false);
    }
  }, [text, parked, live, runId, harness.harnessHash, attachments]);

  const askQuestion = parked ? (run?.pendingQuestion ?? null) : null;
  const composerHint = parked
    ? 'answering — your reply authorizes the action and lands on the record'
    : live
      ? 'steering — guidance for its next step, never authorization'
      : attachments.length > 0
        ? `${attachments.map((a) => a.name).join(', ')} will ride this run`
        : 'start a run';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      {/* ---------------- the conversation ---------------- */}
      <section className="flex min-h-[70vh] flex-col">
        <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
          <span className={`${MONO} uppercase tracking-[0.13em] text-faint`}>
            {harness.spec?.mission.kind === 'standing' ? 'standing mission' : 'the work'}
          </span>
          <span className={`${MONO} ${tone.cls}`} data-testid="chat-state">
            {tone.label}
            {run?.cost !== undefined ? (
              <span className="text-faint"> · ${run.cost.meteredUsd.toFixed(4)} metered</span>
            ) : null}
          </span>
        </div>

        <div ref={threadRef} className="min-h-0 flex-1 divide-y divide-line overflow-y-auto pr-1">
          {/* The job is the first message — the operator's own words. */}
          <div className="px-1 py-3">
            <span className={`${MONO} uppercase tracking-[0.12em] text-faint`}>you</span>
            <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink">
              {harness.spec?.mission.goal}
            </p>
          </div>
          {turns.length === 0 ? (
            <p className={`${MONO} px-1 py-6 text-faint`} data-testid="chat-empty">
              {runId === null ? 'no runs yet — send it to work below' : 'starting…'}
            </p>
          ) : (
            turns.map((s) => <Turn key={s.seq} step={s} />)
          )}
        </div>

        {/* the ask, impossible to miss, right above the box that answers it */}
        {askQuestion !== null ? (
          <div className="mt-3 border border-warn bg-white px-4 py-3" data-testid="chat-ask">
            <span className={`${MONO} uppercase tracking-[0.13em] text-warn`}>it needs you</span>
            <p className="mt-1 text-[14.5px] leading-relaxed text-ink">{askQuestion}</p>
          </div>
        ) : null}

        {/* ---------------- the one composer ---------------- */}
        <div className="mt-3">
          <div
            className={`border bg-white transition-colors ${
              parked ? 'border-warn' : 'border-[#c4bfb2] focus-within:border-accent'
            }`}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
              }}
              rows={2}
              disabled={busy}
              placeholder={
                parked
                  ? 'your answer…'
                  : live
                    ? 'steer it — e.g. “skip the pricing pages, focus on the changelog”'
                    : 'add anything for this run (optional), then send it to work'
              }
              className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[14.5px] leading-relaxed text-ink outline-none placeholder:text-faint disabled:opacity-60"
              data-testid="chat-input"
            />
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-1.5">
              <div className="flex items-center gap-3">
                {terminal ? (
                  <label className={`${MONO} cursor-pointer text-faint underline decoration-line underline-offset-4 hover:text-accent`}>
                    attach
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => void pickFiles(e.target.files)}
                      data-testid="chat-attach"
                    />
                  </label>
                ) : null}
                <span className={`${MONO} text-faint`}>{composerHint}</span>
              </div>
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy || ((parked || live) && text.trim() === '')}
                className="bg-ink px-4 py-1.5 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-25"
                data-testid="chat-send"
              >
                {busy ? '…' : parked ? 'Answer' : live ? 'Steer' : 'Send to work'}
              </button>
            </div>
          </div>
          {note !== null ? (
            <p className="mt-1.5 text-[12.5px] text-refuse" data-testid="chat-note">
              {note}
            </p>
          ) : null}
        </div>
      </section>

      {/* ---------------- the bench + settings ---------------- */}
      <aside className="space-y-6">
        {runId !== null && run?.files !== undefined && run.files.length > 0 ? (
          <LabWorkbench
            runId={runId}
            files={run.files}
            live={live}
            nowTitle={live ? (turns[turns.length - 1]?.title ?? null) : null}
            nowAt={turns[turns.length - 1]?.at ?? null}
          />
        ) : null}

        {run?.judge != null && 'overall' in run.judge ? (
          <div className="border border-line bg-white px-4 py-3" data-testid="chat-judge">
            <span className={`${MONO} uppercase tracking-[0.13em] text-faint`}>scored against your bar</span>
            <p className="mt-1 text-[15px] font-medium text-ink">{run.judge.overall}/10</p>
            {run.judge.rationale !== '' ? (
              <p className="mt-1 text-[13px] leading-relaxed text-soft">{run.judge.rationale}</p>
            ) : null}
          </div>
        ) : null}

        <div className="border border-line bg-white px-4 py-3">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="flex w-full items-baseline justify-between"
            data-testid="settings-toggle"
          >
            <span className={`${MONO} uppercase tracking-[0.13em] text-faint`}>settings</span>
            <span className={`${MONO} text-faint`}>{showSettings ? 'hide' : 'show'}</span>
          </button>
          {showSettings ? <div className="mt-3">{<SettingsPane harness={harness} />}</div> : null}
        </div>
      </aside>
    </div>
  );
}

'use client';
// Lab client components (Step 8 — the novice loop, ugly ON PURPOSE).
//
// Honesty rules carried into the UI:
//  · narration is POLLING over durable rows (1.5s) — the timeline IS the
//    checkpoint record; nothing streams, nothing is invented;
//  · the cost ticker shows METERED truth and the labeled "est." figure as
//    TWO numbers — never a blended total;
//  · anything not live-evidenced renders a SIMULATED badge;
//  · declared superpowers render their typed not-connected badge.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const box: React.CSSProperties = { border: '1px solid #ccc', padding: 12, marginBottom: 12 };
const badge: React.CSSProperties = {
  display: 'inline-block', padding: '1px 6px', marginLeft: 6,
  fontSize: 11, border: '1px solid #999', borderRadius: 3, verticalAlign: 'middle',
};

export function SimulatedBadge({ simulated }: { simulated: boolean }) {
  return simulated ? <span style={{ ...badge, background: '#fef3c7' }}>SIMULATED</span> : null;
}

export function NotConnectedBadge() {
  return <span style={{ ...badge, background: '#fee2e2' }}>not-connected</span>;
}

// ---------------------------------------------------------------------------
// Interview form (the Step 6 four questions, one plain form)
// ---------------------------------------------------------------------------

interface GenerateResponse {
  kind?: 'complete' | 'draft' | 'refused';
  harnessHash?: string;
  gaps?: Array<{ code: string; question?: string }>;
  reason?: string;
  detail?: string;
  error?: { message?: string };
}

export function InterviewForm() {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<'task' | 'standing'>('task');
  const [done, setDone] = useState('');
  const [accounts, setAccounts] = useState('');
  const [worth, setWorth] = useState('1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/lab/harnesses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          answers: {
            goal,
            kind,
            ...(kind === 'task' && done ? { doneDefinition: done } : {}),
            accounts: accounts.split(',').map((s) => s.trim()).filter(Boolean),
            worthUsd: Number(worth),
          },
        }),
      });
      const body = (await res.json()) as GenerateResponse;
      setResult(body);
      if (res.status === 201 && body.harnessHash) {
        router.push(`/lab/harness/${body.harnessHash}`);
      }
    } finally {
      setBusy(false);
    }
  }, [goal, kind, done, accounts, worth, router]);

  return (
    <div style={box} data-testid="interview-form">
      <h3>Build a harness</h3>
      <p>
        <label>
          1. What should it do?{' '}
          <input value={goal} onChange={(e) => setGoal(e.target.value)} size={60} data-testid="q-goal" />
        </label>
      </p>
      <p>
        <label>
          2. One-off task or standing mission?{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as 'task' | 'standing')} data-testid="q-kind">
            <option value="task">task</option>
            <option value="standing">standing</option>
          </select>
        </label>{' '}
        {kind === 'task' ? (
          <label>
            How will it know it&apos;s done?{' '}
            <input value={done} onChange={(e) => setDone(e.target.value)} size={40} data-testid="q-done" />
          </label>
        ) : null}
      </p>
      <p>
        <label>
          3. Which accounts/services does it touch? (comma-separated, may be empty){' '}
          <input value={accounts} onChange={(e) => setAccounts(e.target.value)} size={40} data-testid="q-accounts" />
        </label>
      </p>
      <p>
        <label>
          4. What is one {kind === 'task' ? 'run' : 'check'} worth to you, in dollars?{' '}
          <input value={worth} onChange={(e) => setWorth(e.target.value)} size={8} data-testid="q-worth" />
        </label>
      </p>
      <button onClick={submit} disabled={busy || goal.length === 0} data-testid="interview-submit">
        {busy ? 'Generating…' : 'Generate my harness'}
      </button>
      {result?.kind === 'draft' ? (
        <div style={{ marginTop: 8 }} data-testid="gen-draft">
          <b>One more question:</b>
          <ul>{(result.gaps ?? []).map((g, i) => <li key={i}>{g.question ?? g.code}</li>)}</ul>
        </div>
      ) : null}
      {result?.kind === 'refused' ? (
        <div style={{ marginTop: 8 }} data-testid="gen-refused">
          <b>Refused ({result.reason}):</b> {result.detail}
        </div>
      ) : null}
      {result?.error ? <div style={{ marginTop: 8 }}>{result.error.message}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start-trial button (harness page)
// ---------------------------------------------------------------------------

export function StartTrialButton({ harnessHash }: { harnessHash: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/lab/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harnessHash }),
      });
      const body = (await res.json()) as { runId?: string; error?: { message?: string } };
      if (res.status === 202 && body.runId) router.push(`/lab/run/${body.runId}`);
      else setError(body.error?.message ?? `start failed (${res.status})`);
    } finally {
      setBusy(false);
    }
  }, [harnessHash, router]);
  return (
    <span>
      <button onClick={start} disabled={busy} data-testid="start-trial">
        {busy ? 'Starting…' : 'Run a trial'}
      </button>
      {error ? <span style={{ marginLeft: 8 }}>{error}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Run view: poll durable rows, narrate, ticker, check-in answer, kill
// ---------------------------------------------------------------------------

interface RunStep {
  seq: number;
  kind: 'model' | 'tool' | 'check-in';
  at: string;
  slot: 'brain' | 'tools' | null;
  excerpt: string;
  estCostUsd?: number;
  meteredCostUsd?: number | null;
  costLabel?: 'metered' | 'est.';
  provenance?: string | null;
  simulated?: boolean;
}

interface RunResponse {
  runId: string;
  harnessHash: string;
  harnessName: string;
  state: string;
  stateReason: string | null;
  pendingQuestion: string | null;
  superpowers: Array<{ id: string; status: 'not-connected' }>;
  steps: RunStep[];
  cost: { meteredUsd: number; estPendingUsd: number };
  error?: { message?: string };
}

const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);

export function RunView({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunResponse | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/lab/runs/${runId}`);
    if (res.ok) setRun((await res.json()) as RunResponse);
  }, [runId]);

  useEffect(() => {
    void poll();
    timer.current = setInterval(() => void poll(), 1500);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [poll]);

  useEffect(() => {
    if (run && TERMINAL.has(run.state) && timer.current) clearInterval(timer.current);
  }, [run]);

  const sendAnswer = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/lab/runs/${runId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      setAnswer('');
      // Resume polling — the answered leg writes new durable rows.
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => void poll(), 1500);
    } finally {
      setBusy(false);
    }
  }, [runId, answer, poll]);

  const kill = useCallback(async () => {
    await fetch(`/api/lab/runs/${runId}/kill`, { method: 'POST' });
    void poll();
  }, [runId, poll]);

  if (run === null) return <p>Loading run…</p>;

  const anySimulated = run.steps.some((s) => s.simulated === true);
  return (
    <div data-testid="run-view" data-state={run.state}>
      <h2>
        {run.harnessName} <span style={badge}>{run.state}</span>
        <SimulatedBadge simulated={anySimulated} />
      </h2>
      {run.stateReason ? <p data-testid="state-reason">{run.stateReason}</p> : null}
      {run.superpowers.length > 0 ? (
        <p data-testid="run-posture">
          This trial ran <b>brain-only</b> — declared superpowers:{' '}
          {run.superpowers.map((s) => (
            <span key={s.id}>
              {s.id}
              <NotConnectedBadge />{' '}
            </span>
          ))}
        </p>
      ) : null}
      <p data-testid="cost-ticker">
        Cost so far: <b>${run.cost.meteredUsd.toFixed(4)}</b> metered
        {run.cost.estPendingUsd > 0 ? (
          <span>
            {' '}
            + <b>${run.cost.estPendingUsd.toFixed(4)}</b> <i>est.</i> (unresolved steps)
          </span>
        ) : null}
      </p>
      {run.pendingQuestion !== null && run.state === 'awaiting-human' ? (
        <div style={{ ...box, background: '#eff6ff' }} data-testid="check-in">
          <b>The harness asks:</b> {run.pendingQuestion}
          <p>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} size={60} data-testid="answer-input" />
            <button onClick={sendAnswer} disabled={busy || answer.length === 0} data-testid="answer-submit">
              Answer
            </button>
          </p>
        </div>
      ) : null}
      <ol data-testid="narration">
        {run.steps.map((s) => (
          <li key={s.seq} style={{ marginBottom: 6 }}>
            <b>{s.kind}</b>
            {s.slot ? <span style={badge}>{s.slot}</span> : null}
            {s.kind === 'model' ? <SimulatedBadge simulated={s.simulated === true} /> : null}
            {s.kind === 'model' ? (
              <span style={{ marginLeft: 6, fontSize: 12 }}>
                {s.costLabel === 'metered'
                  ? `$${(s.meteredCostUsd ?? 0).toFixed(4)} metered`
                  : `$${(s.estCostUsd ?? 0).toFixed(4)} est.`}
              </span>
            ) : null}
            <div style={{ whiteSpace: 'pre-wrap' }}>{s.excerpt}</div>
          </li>
        ))}
      </ol>
      <p>
        {!TERMINAL.has(run.state) ? (
          <button onClick={kill} data-testid="kill-run">
            Stop this run
          </button>
        ) : (
          <a href={`/lab/run/${runId}/report`} data-testid="report-link">
            Open the report →
          </a>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory editor (plain-language v1)
// ---------------------------------------------------------------------------

export function MemoryEntryEditor({
  harnessHash,
  entryKey,
  initialText,
}: {
  harnessHash: string;
  entryKey: string;
  initialText: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const save = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/lab/memory/${harnessHash}/${encodeURIComponent(entryKey)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [harnessHash, entryKey, text, router]);
  const remove = useCallback(async () => {
    // Deletion is PERMANENT and immediate — no tombstone (stated semantics).
    if (!window.confirm(`Delete memory '${entryKey}' permanently? There is no undo.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/lab/memory/${harnessHash}/${encodeURIComponent(entryKey)}`, { method: 'DELETE' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [harnessHash, entryKey, router]);
  return (
    <span>
      <input value={text} onChange={(e) => setText(e.target.value)} size={50} data-testid={`memory-edit-${entryKey}`} />
      <button onClick={save} disabled={busy}>
        Save
      </button>
      <button onClick={remove} disabled={busy}>
        Delete (permanent)
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connector panel (Step 10) — the filament's control surface: catalog +
// grant STATUSES only (token material structurally absent from the API),
// Connect starts the PKCE flow (admin), Revoke is the typed cut.
// ---------------------------------------------------------------------------

interface ConnectorDto {
  connectorId: string;
  displayName: string;
  scopesOffered: string[];
  tools: string[];
  configured: boolean;
  status: 'not-connected' | 'connected' | 'expired' | 'revoked';
  grant: { scopesGranted: string[]; grantedBy: string; revokedAt: string | null } | null;
}

const STATUS_BG: Record<ConnectorDto['status'], string> = {
  'not-connected': '#fee2e2',
  connected: '#dcfce7',
  expired: '#fef3c7',
  revoked: '#e5e7eb',
};

export function ConnectorPanel() {
  const [connectors, setConnectors] = useState<ConnectorDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/lab/connectors');
    if (res.ok) setConnectors(((await res.json()) as { connectors: ConnectorDto[] }).connectors);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(
    async (id: string) => {
      setBusy(true);
      setNote(null);
      try {
        const res = await fetch(`/api/lab/connectors/${id}/oauth/start`, { method: 'POST' });
        const body = (await res.json()) as { authorizationUrl?: string; error?: { message?: string } };
        if (res.ok && body.authorizationUrl) {
          window.location.href = body.authorizationUrl; // the operator approves BY HAND
        } else {
          setNote(body.error?.message ?? `connect failed (${res.status})`);
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const revoke = useCallback(
    async (id: string) => {
      if (!window.confirm(`Revoke the ${id} grant? The filament shows the cut immediately.`)) return;
      setBusy(true);
      try {
        await fetch(`/api/lab/connectors/${id}/revoke`, { method: 'POST' });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (connectors === null) return null;
  return (
    <div style={box} data-testid="connector-panel">
      <strong>Superpower connections</strong>
      {note ? <div style={{ color: '#b91c1c', fontSize: 12 }}>{note}</div> : null}
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {connectors.map((c) => (
          <li key={c.connectorId} data-testid={`connector-${c.connectorId}`} data-status={c.status}>
            {c.displayName}
            <span style={{ ...badge, background: STATUS_BG[c.status] }}>{c.status}</span>
            <span style={{ fontSize: 11, color: '#6b7688', marginLeft: 6 }}>
              {c.tools.length} read tools{c.scopesOffered.length === 0 ? ' · zero-scope grant' : ''}
            </span>
            {c.status === 'connected' ? (
              <button onClick={() => void revoke(c.connectorId)} disabled={busy} style={{ marginLeft: 8 }}>
                Revoke
              </button>
            ) : (
              <button
                onClick={() => void connect(c.connectorId)}
                disabled={busy || !c.configured}
                title={c.configured ? '' : 'set the connector client id/secret env vars'}
                style={{ marginLeft: 8 }}
              >
                {c.status === 'not-connected' ? 'Connect' : 'Reconnect'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

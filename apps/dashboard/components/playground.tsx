'use client';

// Playground (M4 #31, SPEC §13.3): chat against any point of a cluster's
// current frontier — or 'potion-auto' (the org's bound policy resolves the
// operating point exactly like the serving path). Side-by-side compare runs
// the SAME conversation through two points and reports per-answer
// latency/cost. Provenance is badged from the SSE meta chunk: anything that
// is not live-backed evidence is badged SIMULATED, never presented as live.
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { describeStrategy } from '@/lib/frontier-chart';
import type { FrontierPointDto, FrontierResponse } from '@/lib/types';

interface Turn {
  user: string;
  assistant: string;
  meta: TurnMeta | null;
  error: string | null;
}

interface TurnMeta {
  latencyMs: number | null;
  costUsd: number | null;
  provenance: string | null;
  strategyHash: string | null;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface PaneState {
  selection: string; // 'auto' or a strategyHash
  turns: Turn[];
  streaming: boolean;
}

const EMPTY_PANE: PaneState = { selection: 'auto', turns: [], streaming: false };

/** Parse one SSE frame's `data:` payloads into JSON objects. */
function* sseObjects(frame: string): Generator<Record<string, unknown>> {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '' || data === '[DONE]') continue;
    try {
      yield JSON.parse(data) as Record<string, unknown>;
    } catch {
      // partial frame — the \n\n boundary guarantees completeness, so a
      // parse failure here is a contract violation; ignore defensively.
    }
  }
}

function Pane({
  title,
  points,
  pane,
  onSelect,
}: {
  title: string;
  points: FrontierPointDto[];
  pane: PaneState;
  onSelect: (selection: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex min-h-[28rem] flex-1 flex-col rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-4 py-3">
        <div className="mb-2 text-xs font-medium text-faint">{title}</div>
        <select
          value={pane.selection}
          onChange={(e) => onSelect(e.target.value)}
          disabled={pane.streaming}
          className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink"
        >
          <option value="auto">potion-auto — your policy routes this</option>
          {points.map((p) => (
            <option key={p.strategyHash} value={p.strategyHash}>
              {describeStrategy(p.strategyConfig)} · q{p.quality.toFixed(2)} · $
              {p.costPer1K.toFixed(3)}/1K
              {p.providerMode !== 'live' ? ' · SIMULATED' : ''}
            </option>
          ))}
        </select>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {pane.turns.length === 0 ? (
          <p className="text-sm text-faint">
            Send a message below — this pane answers with the selected point.
          </p>
        ) : (
          pane.turns.map((t, i) => (
            <div key={i} className="space-y-2">
              <div className="rounded-lg bg-paper px-3 py-2 text-sm text-ink">{t.user}</div>
              <div className="rounded-lg border border-line px-3 py-2 text-sm text-soft">
                {t.assistant === '' && !t.error ? (
                  <span className="text-faint">…</span>
                ) : (
                  t.assistant
                )}
                {t.error ? <span className="block text-xs text-warn">{t.error}</span> : null}
              </div>
              {t.meta ? (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                  {t.meta.latencyMs !== null ? <span>{t.meta.latencyMs.toFixed(0)} ms</span> : null}
                  {t.meta.costUsd !== null ? <span>${t.meta.costUsd.toFixed(5)}</span> : null}
                  {t.meta.strategyHash !== null ? (
                    <span className="font-mono">{t.meta.strategyHash.slice(0, 8)}</span>
                  ) : null}
                  {t.meta.provenance !== null && t.meta.provenance !== 'live' ? (
                    <span className="rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warn">
                      SIMULATED
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function Playground({
  clusters,
  selected,
  frontier,
}: {
  clusters: { clusterId: string; version: number }[];
  selected: string;
  frontier: FrontierResponse;
}) {
  const [compare, setCompare] = useState(false);
  const [paneA, setPaneA] = useState<PaneState>(EMPTY_PANE);
  const [paneB, setPaneB] = useState<PaneState>({ ...EMPTY_PANE });
  const [input, setInput] = useState('');
  const points = frontier.frontier.points;

  const runPane = useCallback(
    async (
      pane: 'A' | 'B',
      selection: string,
      history: ChatMessage[],
      setPane: React.Dispatch<React.SetStateAction<PaneState>>,
    ) => {
      setPane((p) => ({
        ...p,
        streaming: true,
        turns: [...p.turns, { user: history[history.length - 1]!.content, assistant: '', meta: null, error: null }],
      }));
      const patchTurn = (patch: Partial<Turn>): void => {
        setPane((p) => {
          const turns = [...p.turns];
          turns[turns.length - 1] = { ...turns[turns.length - 1]!, ...patch };
          return { ...p, turns };
        });
      };
      try {
        const res = await fetch('/api/playground/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clusterId: selected,
            messages: history,
            ...(selection === 'auto' ? { auto: true } : { strategyHash: selection }),
          }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          patchTurn({ error: body?.error?.message ?? `request failed (${res.status})` });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let assistant = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const obj of sseObjects(frame)) {
              const choices = obj.choices as
                | { delta?: { content?: string } }[]
                | undefined;
              if (choices && choices.length > 0) {
                const content = choices[0]?.delta?.content;
                if (content) {
                  assistant += content;
                  patchTurn({ assistant });
                }
              } else if (obj.usage) {
                patchTurn({
                  meta: {
                    latencyMs: typeof obj.latency_ms === 'number' ? obj.latency_ms : null,
                    costUsd: typeof obj.cost_usd === 'number' ? obj.cost_usd : null,
                    provenance: typeof obj.provenance === 'string' ? obj.provenance : null,
                    strategyHash: typeof obj.strategy_hash === 'string' ? obj.strategy_hash : null,
                  },
                });
              } else if (obj.error) {
                const message = (obj.error as { message?: string }).message;
                patchTurn({ error: message ?? 'stream error' });
              }
            }
          }
        }
        if (assistant === '') patchTurn({ error: 'empty response' });
      } catch (e) {
        patchTurn({ error: (e as Error).message });
      } finally {
        setPane((p) => ({ ...p, streaming: false }));
      }
      void pane;
    },
    [selected],
  );

  function historyFor(pane: PaneState, next: string): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const t of pane.turns) {
      msgs.push({ role: 'user', content: t.user });
      if (t.assistant) msgs.push({ role: 'assistant', content: t.assistant });
    }
    msgs.push({ role: 'user', content: next });
    return msgs;
  }

  async function send() {
    const text = input.trim();
    if (text === '' || paneA.streaming || (compare && paneB.streaming)) return;
    setInput('');
    const histA = historyFor(paneA, text);
    const jobs: Promise<void>[] = [runPane('A', paneA.selection, histA, setPaneA)];
    if (compare) {
      const histB = historyFor(paneB, text);
      jobs.push(runPane('B', paneB.selection, histB, setPaneB));
    }
    await Promise.all(jobs);
  }

  const busy = paneA.streaming || (compare && paneB.streaming);

  return (
    <div>
      {/* cluster selector — plain links, no JS required (same pattern as
          the frontiers page) */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {clusters.map((c) => (
          <Link
            key={c.clusterId}
            href={`/playground?cluster=${encodeURIComponent(c.clusterId)}`}
            className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
              c.clusterId === selected
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-line bg-panel text-soft hover:text-ink'
            }`}
          >
            {c.clusterId}
            <span className="ml-2 text-xs text-faint">v{c.version}</span>
          </Link>
        ))}
        <label className="ml-auto flex items-center gap-2 text-sm text-soft">
          <input
            type="checkbox"
            checked={compare}
            onChange={(e) => setCompare(e.target.checked)}
            className="accent-accent"
          />
          Compare two points
        </label>
      </div>

      <div className={`flex gap-4 ${compare ? 'flex-col lg:flex-row' : ''}`}>
        <Pane
          title={compare ? 'Point A' : 'Point'}
          points={points}
          pane={paneA}
          onSelect={(s) => setPaneA({ ...EMPTY_PANE, selection: s })}
        />
        {compare ? (
          <Pane
            title="Point B"
            points={points}
            pane={paneB}
            onSelect={(s) => setPaneB({ ...EMPTY_PANE, selection: s })}
          />
        ) : null}
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Message ${selected}…`}
          disabled={busy}
          className="flex-1 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink placeholder:text-faint disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
          className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-opacity disabled:opacity-50"
        >
          {busy ? 'Running…' : compare ? 'Send to both' : 'Send'}
        </button>
      </form>
      <p className="mt-3 text-xs text-faint">
        Playground runs are never logged to usage and never shadow/guarantee sampled — this is an
        experiment surface, not served traffic. Simulated points are badged SIMULATED.
      </p>
    </div>
  );
}

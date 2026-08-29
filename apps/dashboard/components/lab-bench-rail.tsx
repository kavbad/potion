'use client';
// THE BENCH RAIL (2026-08-28, operator: "the UX should feel like a studio
// with clear buttons… they shouldn't have to scroll down… the app should
// signal where the things they need to toggle are so they don't have to
// think about it").
//
// A sticky toolbar at the TOP of the specimen page holding every control
// that makes the worker actually work — and a readiness lamp that COUNTS
// what is still unmet, with each unmet item being the very button that
// fixes it, in place:
//   · declared superpowers as power chips — a builtin enables right here
//     (one POST, no scrolling); an external one starts its OAuth right
//     here too (same endpoint the connections panel uses);
//   · Run a trial — the primary action, always visible;
//   · Arm/Pause for standing missions — armable right here.
// Every state is a real server value (harness.superpowers posture, the
// mission row); nothing pulses unless something is truly unmet.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HarnessDto } from '@potion/lab-form';

interface CatalogLite {
  connectorId: string;
  displayName: string;
  connectStatus: string;
}

export function LabBenchRail({
  harness,
  role,
}: {
  harness: HarnessDto;
  role: 'admin' | 'member' | 'viewer';
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Map<string, CatalogLite>>(new Map());
  useEffect(() => {
    fetch('/api/lab/connectors', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const body = b as { connectors?: CatalogLite[]; custom?: CatalogLite[] } | null;
        const list = [...(body?.connectors ?? []), ...(body?.custom ?? [])];
        if (list.length > 0) setCatalog(new Map(list.map((c) => [c.connectorId, c])));
      })
      .catch(() => null);
  }, []);

  const spec = harness.spec;
  if (spec === null) return null;

  const posture = new Map(harness.superpowers.map((s) => [s.id, s.status]));
  const declared = spec.superpowers.map((s) => s.id);
  const unmetPowers = declared.filter((id) => posture.get(id) !== 'connected');
  const standing = spec.mission.kind === 'standing';
  // P5: event triggers (webhook, feed-change) make a mission armable too.
  const hasCron = spec.checkIns.some((c) => c.trigger === 'cron' || c.trigger === 'webhook' || c.trigger === 'feed-change');
  const armed = harness.mission?.state === 'armed';
  const needsArm = standing && hasCron && !armed;
  const stepsLeft = unmetPowers.length + (needsArm ? 1 : 0);

  const enable = useCallback(
    async (id: string) => {
      setBusyId(id);
      setNote(null);
      try {
        const res = await fetch(`/api/lab/connectors/${id}/oauth/start`, { method: 'POST' });
        const body = (await res.json().catch(() => null)) as
          | { granted?: boolean; authorizationUrl?: string; error?: { message?: string } }
          | null;
        if (res.ok && body?.granted) {
          router.refresh();
        } else if (res.ok && body?.authorizationUrl) {
          window.location.href = body.authorizationUrl; // external OAuth — approved BY HAND
        } else {
          setNote(body?.error?.message ?? `could not enable ${id} (${res.status})`);
        }
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const flipMission = useCallback(
    async (to: 'arm' | 'pause') => {
      setBusyId('mission');
      setNote(null);
      try {
        const res = await fetch(`/api/lab/harnesses/${harness.harnessHash}/${to}`, { method: 'POST' });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          setNote(body?.message ?? `${to} failed (${res.status})`);
        } else {
          router.refresh();
        }
      } finally {
        setBusyId(null);
      }
    },
    [harness.harnessHash, router],
  );

  const runTrial = useCallback(async () => {
    setBusyId('trial');
    setNote(null);
    try {
      const res = await fetch('/api/lab/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harnessHash: harness.harnessHash }),
      });
      const body = (await res.json().catch(() => null)) as { runId?: string; error?: { message?: string } } | null;
      if (res.status === 202 && body?.runId) router.push(`/lab/run/${body.runId}`);
      else setNote(body?.error?.message ?? `start failed (${res.status})`);
    } finally {
      setBusyId(null);
    }
  }, [harness.harnessHash, router]);

  const chip = 'inline-flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[12px] leading-none';
  const canAct = role === 'admin';

  return (
    <div
      className="sticky top-0 z-30 -mx-1 mt-5 border border-[#d9d5cb] bg-[#fbfaf7]/95 px-4 py-2.5 shadow-paper backdrop-blur-sm"
      data-testid="bench-rail"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* readiness lamp — the don't-make-me-think signal */}
        {stepsLeft === 0 ? (
          <span className={`${chip} border-accent/60 text-accent`} data-testid="rail-ready">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" /> ready to work
          </span>
        ) : (
          <span className={`${chip} border-warn text-warn`} data-testid="rail-steps">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
            {stepsLeft} step{stepsLeft === 1 ? '' : 's'} before it can work — they light up here →
          </span>
        )}

        {/* power chips — every declared superpower, actionable in place */}
        {declared.map((id) => {
          const connected = posture.get(id) === 'connected';
          const name = catalog.get(id)?.displayName ?? id;
          if (connected) {
            return (
              <span key={id} className={`${chip} border-[#c4bfb2] text-soft`} data-testid={`rail-power-${id}`} data-on="true">
                <span className="text-accent">⏻</span> {name}
              </span>
            );
          }
          return (
            <button
              key={id}
              type="button"
              onClick={() => void enable(id)}
              disabled={!canAct || busyId !== null}
              title={canAct ? '' : 'an admin enables this'}
              className={`${chip} border-warn bg-white text-ink hover:border-accent hover:text-accent disabled:opacity-40`}
              data-testid={`rail-power-${id}`}
              data-on="false"
            >
              <span className="text-warn">⏻</span> {busyId === id ? 'enabling…' : `Enable ${name}`}
            </button>
          );
        })}

        {/* mission switch — armable where you're looking */}
        {standing && hasCron ? (
          armed ? (
            <button
              type="button"
              onClick={() => void flipMission('pause')}
              disabled={!canAct || busyId !== null}
              className={`${chip} border-accent/60 text-accent hover:border-refuse hover:text-refuse disabled:opacity-40`}
              data-testid="rail-mission"
              data-armed="true"
            >
              ● armed — runs itself · pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void flipMission('arm')}
              disabled={!canAct || busyId !== null}
              className={`${chip} border-warn bg-white text-ink hover:border-accent hover:text-accent disabled:opacity-40`}
              data-testid="rail-mission"
              data-armed="false"
            >
              ○ {busyId === 'mission' ? 'arming…' : 'Arm the mission'}
            </button>
          )
        ) : null}

        <span className="mx-1 hidden h-5 w-px bg-[#d9d5cb] sm:inline-block" />

        {/* the primary action, never below the fold */}
        <button
          type="button"
          onClick={() => void runTrial()}
          disabled={role === 'viewer' || busyId !== null}
          className="bg-ink px-4 py-1.5 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          data-testid="rail-trial"
        >
          {busyId === 'trial' ? 'Starting…' : 'Run a trial'}
        </button>

        <span className="ml-auto flex items-center gap-3 font-mono text-[12px] text-faint">
          {canAct && harness.specText !== undefined ? (
            <button
              type="button"
              onClick={() => {
                const next = window.prompt('Rename this worker (a lawful edit — mints a new version):', spec.name);
                if (next === null || next.trim() === '' || next.trim() === spec.name) return;
                try {
                  const obj = JSON.parse(harness.specText!) as Record<string, unknown>;
                  delete obj['hash'];
                  obj['name'] = next.trim().slice(0, 120);
                  void fetch(`/api/lab/harnesses/${harness.harnessHash}/spec`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ specText: JSON.stringify(obj) }),
                  })
                    .then((r) => r.json())
                    .then((b: { ok?: boolean; harnessHash?: string }) => {
                      if (b.ok && b.harnessHash) window.location.assign(`/lab/harness/${b.harnessHash}`);
                    });
                } catch { /* unparsable spec text — machinery shows why */ }
              }}
              className="hover:text-accent"
              data-testid="rail-rename"
            >
              rename
            </button>
          ) : null}
          <a href="#connections" className="hover:text-accent">connections</a>
          <a href="#machinery" className="hover:text-accent">machinery</a>
        </span>
      </div>
      {note ? <p className="mt-1.5 text-[12.5px] text-refuse">{note}</p> : null}
    </div>
  );
}

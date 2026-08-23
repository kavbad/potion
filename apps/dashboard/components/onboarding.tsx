'use client';

// THE JOURNEY — one guided sequence, in the lab style, that a first-time
// visitor can finish without being told where anything is:
//
//   1 · Your key          2 · Change one line
//   3 · Try a request     4 · Your first receipt, and what it saved
//
// Each step shows its state (done · now · next) from facts the API already
// knows — a live key exists; a request has been served — so a returning
// visitor lands on the step they are actually at. Nothing else competes
// with these four on the first visit.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CopyBlock } from '@/components/copy-block';
import { ServingKeys } from '@/components/serving-keys';
import { TryRequest, type Receipt } from '@/components/try-request';
import { RoutingProof } from '@/components/routing-proof';
import { IncumbentPicker, type Incumbents } from '@/components/incumbent-picker';
import { QualityBar } from '@/components/quality-bar';
import { AgentInstructions } from '@/components/agent-instructions';
import type { ConnectionResponse, RoutingActivityResponse } from '@/lib/types';

type State = 'done' | 'now' | 'next';

function Step({ n, title, state, lede, children }: { n: string; title: string; state: State; lede: string; children: React.ReactNode }) {
  return (
    <section className={`grid gap-6 border-t border-[#d9d5cb] py-10 lg:grid-cols-[9rem_1fr] ${state === 'next' ? 'opacity-60' : ''}`}>
      <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
        <div className="text-ink">{n}</div>
        <div className={`mt-1.5 ${state === 'done' ? 'text-accent' : state === 'now' ? 'text-ink' : ''}`}>
          {state === 'done' ? '✓ done' : state === 'now' ? '→ now' : 'next'}
        </div>
      </div>
      <div className="min-w-0">
        <h2 className="text-[1.375rem] font-medium leading-snug tracking-[-0.01em] text-ink">{title}</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-soft">{lede}</p>
        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}

function TrialReceipt({ r }: { r: Receipt }) {
  const premium = r.alternatives.find((a) => a.rule === 'quality');
  const saved = premium?.cost_per_1k && r.costPer1K !== null && premium.cost_per_1k > 0 ? Math.max(0, Math.floor((1 - r.costPer1K / premium.cost_per_1k) * 100)) : null;
  const usd = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4 font-mono text-[12px]">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[9rem_1fr]">
        <dt className="text-faint">kind of work</dt><dd className="text-ink">{r.clusterId ?? '—'}</dd>
        <dt className="text-faint">routed to</dt><dd className="text-accent">{r.model ?? '—'}{r.quality !== null ? <span className="text-soft"> · scores {r.quality.toFixed(2)}</span> : null}</dd>
        <dt className="text-faint">this request cost</dt><dd className="text-ink">{r.costUsd !== null ? `$${r.costUsd.toFixed(5)}` : '—'}{r.costPer1K !== null ? <span className="text-soft"> · {usd(r.costPer1K)} per 1,000</span> : null}</dd>
        {premium && premium.model && premium.cost_per_1k !== null && (
          <>
            <dt className="text-faint">the premium pick</dt>
            <dd className="text-soft">{premium.model} · {usd(premium.cost_per_1k)} per 1,000{premium.quality !== null ? ` · scores ${premium.quality.toFixed(2)}` : ''}</dd>
          </>
        )}
        {saved !== null && saved > 0 && (
          <>
            <dt className="text-faint">saved</dt>
            <dd className="text-accent">{saved}% on this kind of work, at or above your quality floor</dd>
          </>
        )}
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        Every answer through your key carries a receipt like this. Usage &amp; savings adds them up.
      </p>
    </div>
  );
}

export function Onboarding({ conn: initial, admin = true }: { conn: ConnectionResponse; admin?: boolean }) {
  const [conn, setConn] = useState(initial);
  const [activity, setActivity] = useState<RoutingActivityResponse | null>(null);
  const [tick, setTick] = useState(0);
  // The trial's own receipt counts as the first receipt: trial requests do
  // not enter the serving log, and a first-time visitor should not have to
  // wire code before step 4 means anything.
  const [trial, setTrial] = useState<Receipt | null>(null);
  // What they use today — the incumbent the learning period measures against.
  const [incumbents, setIncumbents] = useState<Incumbents | null | undefined>(undefined);
  useEffect(() => {
    fetch('/api/incumbents', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Incumbents | null) => setIncumbents(b && (b.models.length > 0 || b.other) ? b : null))
      .catch(() => setIncumbents(null));
  }, []);
  // After a key is issued or a request sent, the facts change: re-read them
  // so the steps advance without a reload.
  useEffect(() => {
    if (tick === 0) return;
    fetch('/api/connection', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: ConnectionResponse | null) => { if (b) setConn(b); })
      .catch(() => null);
  }, [tick]);
  useEffect(() => {
    fetch('/api/routing-activity?limit=5', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: RoutingActivityResponse | null) => setActivity(b))
      .catch(() => setActivity(null));
  }, [tick]);

  const hasKey = conn.servingKeys.some((k) => !k.revokedAt);
  const served = (activity?.summary?.returned ?? 0) > 0 || trial !== null;
  const hasIncumbent = !!incumbents;
  const s1: State = hasKey ? 'done' : 'now';
  const sI: State = !hasKey ? 'next' : hasIncumbent ? 'done' : 'now';
  const s2: State = !hasKey || !hasIncumbent ? 'next' : served ? 'done' : 'now';
  const s3: State = !hasKey || !hasIncumbent ? 'next' : served ? 'done' : 'now';
  const s4: State = served ? 'now' : 'next';

  return (
    <div className="max-w-4xl">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
        {served ? 'You are routing' : hasKey ? (hasIncumbent ? 'Two steps left' : 'Three steps left') : 'Five steps, about two minutes'}
      </div>
      <h1 className="mt-3 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
        {served ? 'Your requests are being routed.' : 'Get routed in a minute.'}
      </h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">
        {served
          ? 'Every answer carries a receipt: what kind of work it was, which measured model got it, and what that cost against the premium model.'
          : 'A key, one line in your code, one request. Then you will see, on a receipt, what Potion chose for it and what that saved.'}
      </p>

      <div className="mt-10">
        <Step n="01" title="Your key" state={s1} lede={hasKey ? 'Issued. Potion stores only a hash, so it is shown once; issue another any time.' : 'Issue a serving key. It is shown once; Potion keeps only a hash of it.'}>
          <div onClickCapture={() => setTimeout(() => setTick((t) => t + 1), 1500)}>
            <ServingKeys initial={initial.servingKeys} />
          </div>
        </Step>

        <Step n="02" title="What do you use today?" state={sI} lede="Name the model your requests go to now. Potion measures your workloads against it and routes each kind of work to the right model, so the rule becomes 'never below what I get today', not a number we picked.">
          {incumbents === undefined ? (
            <p className="font-mono text-[11px] text-faint">loading</p>
          ) : (
            <>
              <IncumbentPicker initial={incumbents} onSaved={(i) => setIncumbents(i)} />
              {incumbents && <QualityBar admin={admin} />}
            </>
          )}
        </Step>

        <Step n="03" title="Change one line" state={s2} lede="Potion speaks the OpenAI chat protocol. Point your existing client here and keep everything else: the request, the response, streaming, tool calls. Or hand the instructions to your coding agent.">
          <div className="space-y-4">
            <AgentInstructions baseUrl={conn.baseUrl} />
            <CopyBlock label="Base URL" text={`${conn.baseUrl}/v1`} />
            {conn.snippets && <CopyBlock label="Node.js (openai SDK)" text={conn.snippets.openaiNode} />}
            {conn.policy && (
              <p className="font-mono text-[11px] leading-relaxed text-faint">
                your rule: <span className="text-ink">{conn.policy.description}</span> ·{' '}
                <Link href="/policy" className="text-accent underline">change it</Link>
              </p>
            )}
          </div>
        </Step>

        <Step n="04" title="Try a request" state={s3} lede="No code needed for this one. Type anything, or pick an example; it goes through the same routing your key gets.">
          <TryRequest onReceipt={(r) => { setTrial(r); setTick((t) => t + 1); }} />
        </Step>

        <Step n="05" title="Your first receipt, and what it saved" state={s4} lede={served ? 'What your request was, which measured model got it, and what the premium pick would have cost for the same work.' : 'Appears after your first request.'}>
          {trial ? (
            <TrialReceipt r={trial} />
          ) : served ? (
            <RoutingProof />
          ) : (
            <p className="font-mono text-[11px] text-faint">waiting for a request</p>
          )}
        </Step>
      </div>

      <details className="mt-10 border-t border-[#d9d5cb] pt-6 font-mono text-[11px] text-faint">
        <summary className="cursor-pointer uppercase tracking-[0.16em] hover:text-ink">What Potion can route today · {conn.autoRouting.ready} of {conn.autoRouting.total} kinds of work measured</summary>
        <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {conn.autoRouting.clusters.map((c) => (
            <li key={c.clusterId} className="flex items-center justify-between">
              <span className={c.ready ? 'text-soft' : 'text-faint'}>{c.name}</span>
              <span className={c.ready ? 'text-accent' : 'text-faint'}>{c.ready ? `${c.pointCount} measured` : 'not measured'}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 leading-relaxed">Only measured points are routable; served by Potion across {conn.serving.platformProviders.length} providers, no provider account needed.</p>
      </details>
    </div>
  );
}

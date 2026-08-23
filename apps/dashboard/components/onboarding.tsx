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
import { TryRequest } from '@/components/try-request';
import { RoutingProof } from '@/components/routing-proof';
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

export function Onboarding({ conn: initial }: { conn: ConnectionResponse }) {
  const [conn, setConn] = useState(initial);
  const [activity, setActivity] = useState<RoutingActivityResponse | null>(null);
  const [tick, setTick] = useState(0);
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
  const served = (activity?.summary?.returned ?? 0) > 0;
  const s1: State = hasKey ? 'done' : 'now';
  const s2: State = !hasKey ? 'next' : served ? 'done' : 'now';
  const s3: State = !hasKey ? 'next' : served ? 'done' : 'now';
  const s4: State = served ? 'now' : 'next';

  return (
    <div className="max-w-4xl">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
        {served ? 'You are routing' : hasKey ? 'Two steps left' : 'Four steps, about a minute'}
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

        <Step n="02" title="Change one line" state={s2} lede="Potion speaks the OpenAI chat protocol. Point your existing client here and keep everything else: the request, the response, streaming, tool calls.">
          <div className="space-y-4">
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

        <Step n="03" title="Try a request" state={s3} lede="No code needed for this one. Type anything, or pick an example; it goes through the same routing your key gets.">
          <div onClickCapture={() => setTimeout(() => setTick((t) => t + 1), 6000)}>
            <TryRequest />
          </div>
        </Step>

        <Step n="04" title="Your first receipt, and what it saved" state={s4} lede={served ? 'Each row is a request you sent, the model it went to, and the premium price it did not pay.' : 'Appears after your first request.'}>
          {served ? <RoutingProof /> : <p className="font-mono text-[11px] text-faint">waiting for a request</p>}
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

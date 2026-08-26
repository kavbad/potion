'use client';

// THE FRONT DOOR, in two honest states (surface review, 2026-08-24 — the
// operator's verdict on the old page: a five-step checklist that never
// graduated, wearing a "you are routing" banner over a key-management table).
//
//   CONNECT  — no routed serving traffic yet: the three things between you
//              and your first receipt (key → one line → test request), with
//              no numbered ceremony. The incumbent question is NOT here: the
//              first-run gate owns it at signup, Settings · Controls after.
//   OVERVIEW — real traffic exists: what routed today, what it cost, what it
//              saved, the recent receipts, and the frontier status. Key
//              management lives in Settings · Keys, where it always did.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CopyBlock } from '@/components/copy-block';
import { ServingKeys } from '@/components/serving-keys';
import { TryRequest, type Receipt } from '@/components/try-request';
import { TodayPulse } from '@/components/today-pulse';
import { BarProposal } from '@/components/bar-proposal';
import { WeeklyBrief } from '@/components/weekly-brief';
import { ReceiptCard } from '@/components/primitives';
import { FIRST_RECEIPT_KEY } from '@/components/first-run';
import { RoutingProof } from '@/components/routing-proof';
import { FrontierStatus } from '@/components/frontier-status';
import { AgentInstructions } from '@/components/agent-instructions';
import type { ConnectionResponse, RoutingActivityResponse } from '@/lib/types';

function ClustersDisclosure({ conn }: { conn: ConnectionResponse }) {
  return (
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
  );
}

export function HomeOverview({ conn: initial, initialActivity = null }: { conn: ConnectionResponse; initialActivity?: RoutingActivityResponse | null }) {
  const [conn, setConn] = useState(initial);
  const [activity, setActivity] = useState<RoutingActivityResponse | null>(initialActivity);
  const [trial, setTrial] = useState<Receipt | null>(null);
  // S1: the first-run flow stores its printed receipt; Today opens with it —
  // there is no empty dashboard anywhere in the journey.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FIRST_RECEIPT_KEY);
      if (raw) setTrial((t) => t ?? (JSON.parse(raw) as Receipt));
    } catch { /* private mode */ }
  }, []);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (tick === 0) return;
    fetch('/api/connection', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: ConnectionResponse | null) => { if (b) setConn(b); })
      .catch(() => null);
  }, [tick]);
  useEffect(() => {
    if (tick === 0) return; // the server already fetched the first read
    fetch('/api/routing-activity?limit=8', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: RoutingActivityResponse | null) => { if (b) setActivity(b); })
      .catch(() => null);
  }, [tick]);

  const hasKey = conn.servingKeys.some((k) => !k.revokedAt);
  // "Routing" means the SERVING log carries decisions — a trial request in
  // this session counts too, so the page graduates the moment value exists.
  const routing = (activity?.summary?.withRoutingDecision ?? 0) > 0 || trial !== null;

  if (routing) {
    return (
      <div className="max-w-4xl">
        <TodayPulse />
        <BarProposal />
        <WeeklyBrief />

        {/* the S1 contract in one quiet line each: where traffic points, and under what rule */}
        <p className="mt-4 font-mono text-[11px] leading-relaxed text-faint">
          Base URL <span className="text-ink">{conn.baseUrl}/v1</span>
          {' · '}{conn.servingKeys.filter((k) => !k.revokedAt).length} active key{conn.servingKeys.filter((k) => !k.revokedAt).length === 1 ? '' : 's'} (<Link href="/settings/keys" className="text-accent underline">manage</Link>)
          {conn.policy && <> · your rule: <span className="text-ink">{conn.policy.description}</span> (<Link href="/settings/controls" className="text-accent underline">change</Link>)</>}
        </p>

        {trial && <div className="mt-8"><ReceiptCard r={trial} subtitle="your first request" /></div>}

        <div className="mt-8"><RoutingProof /></div>
        <div className="mt-6"><FrontierStatus /></div>

        <p className="mt-8 text-sm text-soft">
          <Link href="/receipts" className="text-accent underline">Receipts</Link>
          {' · '}<Link href="/frontiers" className="text-accent underline">Evidence</Link>
          {' · '}<Link href="/usage" className="text-accent underline">Savings</Link>
          {' · '}<Link href="/try" className="text-accent underline">Try a request</Link>
        </p>

        <ClustersDisclosure conn={conn} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
        {hasKey ? 'One line, then a test request' : 'A key, one line, a test request'}
      </div>
      <h1 className="mt-3 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
        Get routed in a minute.
      </h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">
        Point your existing client at Potion and keep everything else. Then you will see, on a
        receipt, what Potion chose for each request and what that saved.
      </p>

      <div className="mt-10 space-y-10">
        <section className="border-t border-[#d9d5cb] pt-8">
          <h2 className="text-[1.25rem] font-medium tracking-[-0.01em] text-ink">Your key</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-soft">
            Shown once; Potion keeps only a hash. Issue another any time in Settings.
          </p>
          <div className="mt-4" onClickCapture={() => setTimeout(() => setTick((t) => t + 1), 1500)}>
            <ServingKeys initial={conn.servingKeys} />
          </div>
        </section>

        <section className={`border-t border-[#d9d5cb] pt-8 ${hasKey ? '' : 'opacity-60'}`}>
          <h2 className="text-[1.25rem] font-medium tracking-[-0.01em] text-ink">Change one line</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-soft">
            Potion speaks the OpenAI chat protocol — the request, the response, streaming, and tool
            calls all stay as they are. Or hand the instructions to your coding agent.
          </p>
          <div className="mt-4 space-y-4">
            <AgentInstructions baseUrl={conn.baseUrl} />
            <CopyBlock label="Base URL" text={`${conn.baseUrl}/v1`} />
            {conn.snippets && <CopyBlock label="Node.js (openai SDK)" text={conn.snippets.openaiNode} />}
            {conn.policy && (
              <p className="font-mono text-[11px] leading-relaxed text-faint">
                your rule: <span className="text-ink">{conn.policy.description}</span> ·{' '}
                <Link href="/settings/controls" className="text-accent underline">change it</Link>
              </p>
            )}
          </div>
        </section>

        <section className={`border-t border-[#d9d5cb] pt-8 ${hasKey ? '' : 'opacity-60'}`}>
          <h2 className="text-[1.25rem] font-medium tracking-[-0.01em] text-ink">Send a test request</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-soft">
            No code needed. Type anything; it goes through the same routing your key gets, and the
            receipt appears here.
          </p>
          <div className="mt-4">
            <TryRequest onReceipt={(r) => { setTrial(r); setTick((t) => t + 1); }} />
          </div>
        </section>
      </div>

      <ClustersDisclosure conn={conn} />
    </div>
  );
}

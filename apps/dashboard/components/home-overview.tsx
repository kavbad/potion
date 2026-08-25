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
import { RoutingProof } from '@/components/routing-proof';
import { FrontierStatus } from '@/components/frontier-status';
import { AgentInstructions } from '@/components/agent-instructions';
import type { ConnectionResponse, RoutingActivityResponse, UsageCurrentResponse } from '@/lib/types';

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function TrialReceipt({ r }: { r: Receipt }) {
  const premium = r.alternatives.find((a) => a.rule === 'quality');
  const saved = premium?.cost_per_1k && r.costPer1K !== null && premium.cost_per_1k > 0 ? Math.max(0, Math.floor((1 - r.costPer1K / premium.cost_per_1k) * 100)) : null;
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

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
      <div className="text-xs text-faint">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>{value}</div>
    </div>
  );
}

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
  const [current, setCurrent] = useState<UsageCurrentResponse | null>(null);
  const [trial, setTrial] = useState<Receipt | null>(null);
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
  useEffect(() => {
    fetch('/api/usage/current', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: UsageCurrentResponse | null) => setCurrent(b))
      .catch(() => setCurrent(null));
  }, [tick]);

  const hasKey = conn.servingKeys.some((k) => !k.revokedAt);
  // "Routing" means the SERVING log carries decisions — a trial request in
  // this session counts too, so the page graduates the moment value exists.
  const routing = (activity?.summary?.withRoutingDecision ?? 0) > 0 || trial !== null;

  if (routing) {
    const savedMtd = current ? Math.max(0, (current.mtd.baselineCostUsd ?? 0) - current.mtd.costUsd) : 0;
    return (
      <div className="max-w-4xl">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Overview</div>
        <h1 className="mt-3 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
          Your requests are being routed.
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">
          Every answer carries a receipt: what kind of work it was, which measured model got it, and
          what that cost against the premium model.
        </p>

        {current && (
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Today — requests" value={String(current.today.requests)} />
            <Stat label="Today — cost" value={usd(current.today.costUsd)} />
            <Stat label="Month-to-date — cost" value={usd(current.mtd.costUsd)} />
            <Stat label="Saved month-to-date" value={savedMtd > 0 ? usd(savedMtd) : '—'} accent={savedMtd > 0} />
          </div>
        )}

        {/* the S1 contract in one quiet line each: where traffic points, and under what rule */}
        <p className="mt-4 font-mono text-[11px] leading-relaxed text-faint">
          Base URL <span className="text-ink">{conn.baseUrl}/v1</span>
          {' · '}{conn.servingKeys.filter((k) => !k.revokedAt).length} active key{conn.servingKeys.filter((k) => !k.revokedAt).length === 1 ? '' : 's'} (<Link href="/settings/keys" className="text-accent underline">manage</Link>)
          {conn.policy && <> · your rule: <span className="text-ink">{conn.policy.description}</span> (<Link href="/settings/controls" className="text-accent underline">change</Link>)</>}
        </p>

        {trial && <div className="mt-8"><TrialReceipt r={trial} /></div>}

        <div className="mt-8"><RoutingProof /></div>
        <div className="mt-6"><FrontierStatus /></div>

        <p className="mt-8 text-sm text-soft">
          <Link href="/try" className="text-accent underline">Try a request</Link>
          {' · '}<Link href="/usage" className="text-accent underline">Usage &amp; savings</Link>
          {' · '}<Link href="/frontiers" className="text-accent underline">Frontiers — the evidence</Link>
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

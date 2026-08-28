// /lab/harness/[hash] — THE SPECIMEN (LAB-DESIGN.md v2, 2026-08-27). A
// daylight page you can read: the worker's identity up top, a "what
// happens now" guide while it has never run (the operator must never face
// an instrument with no next step), the living form as a dark instrument
// viewport SET INTO the paper, the permission ledger, connections, and the
// OpenClaw wiring card. Step 9's law is untouched: the form remains the
// primary editing surface.
import Link from 'next/link';
import { fetchOrRecover } from '@/lib/recover';
import { LabConsole } from '@/components/lab-console';
import { ConnectorPanel } from '@/components/lab-actions';
import { LabMachinery } from '@/components/lab-machinery';
import { MissionControl } from '@/components/lab-mission';
import { LabPermissionLedger } from '@/components/lab-permission-ledger';
import { BenchLabel, CARD, LabStage, SpecimenMark } from '@/components/lab-bench';
import type { HarnessDto, MemoryDto } from '@potion/lab-form';

export const dynamic = 'force-dynamic';

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

interface RunsResponse {
  runs: Array<{ runId: string; state: string }>;
}

/** The newborn guide — numbered because it IS a sequence. Every claim in it
 * derives from the spec: declared accounts, the real fuel cap, the check-in
 * posture. Renders until the worker has run once; after that the ledger and
 * the run record tell the story. */
function WhatHappensNow({ spec }: { spec: NonNullable<HarnessDto['spec']> }) {
  const powers = spec.superpowers.map((s) => s.id);
  const cap = spec.fuel.maxUsdPerRun;
  const steps: Array<{ title: string; body: React.ReactNode }> = [
    ...(powers.length > 0
      ? [{
          title: `Connect what it touches (${powers.join(', ')})`,
          body: (
            <>
              Connections live in the{' '}
              <a href="#connections" className="text-accent underline">connections section below</a>.
              Until an account is live-connected, trials run <b>brain-only</b>: the worker reasons
              and drafts, but touches nothing real.
            </>
          ),
        }]
      : [{
          title: 'Nothing to connect',
          body: <>This worker declared no outside accounts — it only thinks and writes.</>,
        }]),
    {
      title: 'Run a supervised trial',
      body: (
        <>
          It works under its hard cap — <b>${cap.toFixed(2)} per run</b>, metered, stopped at the
          line. Watch it think in the instrument below; stop it anytime.
        </>
      ),
    },
    {
      title: 'Answer when it asks',
      body: (
        <>
          Before any external action it checks in with you. Every approval, edit, or rejection you
          give lands on its permission record as evidence.
        </>
      ),
    },
    {
      title: 'Let it earn autonomy',
      body: (
        <>
          When the evidence clears the bar for one kind of action, a proposal appears in the
          permission ledger below. Grant it, and that kind of action runs alone — with a standing
          audit sample, and automatic re-supervision the moment performance slips.
        </>
      ),
    },
  ];
  return (
    <section className={`mt-8 ${CARD} border-accent/40 px-6 py-5`} data-testid="what-happens-now">
      <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-accent">
        what happens now
      </div>
      <ol className="mt-3 grid gap-3.5">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3.5">
            <span className="mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/50 font-mono text-[12px] text-accent">
              {i + 1}
            </span>
            <span>
              <span className="block text-[14.5px] font-medium text-ink">{s.title}</span>
              <span className="mt-0.5 block text-[13.5px] leading-relaxed text-soft">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function HarnessPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const [harness, memory, runs, me] = await Promise.all([
    fetchOrRecover<HarnessDto>(`/api/lab/harnesses/${hash}`),
    fetchOrRecover<MemoryDto>(`/api/lab/memory/${hash}`),
    fetchOrRecover<RunsResponse>(`/api/lab/harnesses/${hash}/runs`),
    fetchOrRecover<MeResponse>('/auth/me'),
  ]);
  const latest = runs.runs[0] ?? null;
  const born = (harness as { createdAt?: string }).createdAt;
  const openClawSnippet = [
    `import { registerPotionGate } from '@potion/lab-openclaw';`,
    ``,
    `export default function register(api) {`,
    `  registerPotionGate(api, {`,
    `    apiUrl: 'https://api.withpotion.com',`,
    `    apiKey: process.env.POTION_API_KEY, // a Potion SERVING key`,
    `    harnessHash: '${harness.harnessHash}',`,
    `  });`,
    `}`,
  ].join('\n');

  return (
    <LabStage>
      <nav className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        <Link href="/lab" className="text-soft hover:text-accent">Agents</Link>
        {' · '}the specimen
      </nav>

      <header className="mt-5 flex items-start gap-5">
        <SpecimenMark hash={harness.harnessHash} size={46} />
        <div className="min-w-0">
          <h1 className="text-[1.9rem] font-semibold leading-[1.05] tracking-[-0.02em] text-ink">
            {harness.name}
          </h1>
          <p className="mt-1.5 font-mono text-[12px] text-faint">
            {harness.clusterId}
            {born ? ` · born ${new Date(born).toLocaleDateString()}` : ''} ·{' '}
            <code>{harness.harnessHash.slice(0, 12)}…</code>
            {latest ? (
              <>
                {' · '}latest run{' '}
                <Link href={`/lab/run/${latest.runId}`} className="text-accent underline">
                  {latest.state}
                </Link>
              </>
            ) : (
              ' · never run'
            )}
          </p>
        </div>
      </header>

      {harness.spec === null ? (
        <p className={`mt-8 ${CARD} px-5 py-4 text-[13.5px] text-soft`}>
          This catalog row&apos;s spec no longer parses — the form cannot derive from it. The row is
          preserved; re-generate or edit from a valid row.
        </p>
      ) : (
        <>
          {/* ---- the clock: arm/pause a standing mission ---- */}
          <MissionControl harness={harness} role={me.role} />

          {/* ---- the newborn guide: a next step before any instrument ---- */}
          {latest === null ? <WhatHappensNow spec={harness.spec} /> : null}

          {/* ---- the workbench console: what it is, does, asks, costs ---- */}
          <section className="mt-8">
            <BenchLabel right="every value derives from a real parameter">The worker, live</BenchLabel>
            <div className="mt-3">
              <LabConsole
                harness={harness}
                memory={memory}
                runId={latest?.runId ?? null}
                role={me.role}
                surface="harness"
              />
            </div>
          </section>

          {/* ---- the permission ledger ---- */}
          <LabPermissionLedger harnessHash={harness.harnessHash} role={me.role} />

          {/* ---- connections: the worker's declared accounts, honestly ---- */}
          {harness.spec.superpowers.length > 0 ? (
            <section className="mt-8" id="connections">
              <BenchLabel right="you approve every grant by hand · revoke cuts immediately">Connections</BenchLabel>
              <div className="mt-3">
                <ConnectorPanel declared={harness.spec.superpowers.map((s) => s.id)} />
              </div>
            </section>
          ) : null}

          {/* ---- the machinery: the spec file, its provenance, its laws —
               editable to the detail (2026-08-27: "this is a LAB") ---- */}
          <LabMachinery harness={harness} role={me.role} />

          {/* ---- run it elsewhere: the OpenClaw wiring card ---- */}
          <section className={`mt-8 ${CARD} px-6 py-5`}>
            <BenchLabel right="same trust record, any runtime">Run this worker as an OpenClaw</BenchLabel>
            <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-soft">
              Add this to an OpenClaw plugin and every tool call routes through this worker&apos;s
              permission record: supervised actions ask in your own OpenClaw surface, earned classes
              run free with a standing audit sample — and there is no allow-always. Standing autonomy
              only ever comes from the grants above.
            </p>
            <pre className="mt-4 overflow-x-auto border border-[#d9d5cb] bg-white px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink">
              {openClawSnippet}
            </pre>
          </section>
        </>
      )}
    </LabStage>
  );
}

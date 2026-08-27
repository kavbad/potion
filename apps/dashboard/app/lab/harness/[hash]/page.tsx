// /lab/harness/[hash] — THE SPECIMEN (LAB-DESIGN.md, 2026-08-26). The
// living form is the protagonist on the bench; the permission ledger is a
// PAPER document laid on it (paperwork stays light in either room); the
// OpenClaw wiring card hands over the exact plugin config for running this
// worker on an external runtime under the same trust record. Step 9's law
// is untouched: the form remains the primary editing surface.
import Link from 'next/link';
import { fetchOrRecover } from '@/lib/recover';
import { LabFormView } from '@/components/lab-form-view';
import { ConnectorPanel } from '@/components/lab-actions';
import { LabPermissionLedger } from '@/components/lab-permission-ledger';
import { BENCH, BenchLabel, LabStage, SpecimenMark } from '@/components/lab-bench';
import type { HarnessDto, MemoryDto } from '@potion/lab-form';

export const dynamic = 'force-dynamic';

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

interface RunsResponse {
  runs: Array<{ runId: string; state: string }>;
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
      <nav className="font-mono text-[10.5px] uppercase tracking-[0.18em]" style={{ color: BENCH.faint }}>
        <Link href="/lab" className="hover:underline" style={{ color: BENCH.muted }}>Potion Lab</Link>
        {' · '}the specimen
      </nav>

      <header className="mt-5 flex items-start gap-5">
        <SpecimenMark hash={harness.harnessHash} size={46} />
        <div className="min-w-0">
          <h1 className="text-[1.9rem] font-semibold leading-[1.05] tracking-[-0.02em]" style={{ color: '#eef2f8' }}>
            {harness.name}
          </h1>
          <p className="mt-1.5 font-mono text-[11px]" style={{ color: BENCH.faint }}>
            {harness.clusterId}
            {born ? ` · born ${new Date(born).toLocaleDateString()}` : ''} ·{' '}
            <code>{harness.harnessHash.slice(0, 12)}…</code>
            {latest ? (
              <>
                {' · '}latest run{' '}
                <Link href={`/lab/run/${latest.runId}`} className="underline" style={{ color: BENCH.muted }}>
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
        <p className="mt-8 border px-5 py-4 text-[13.5px]" style={{ borderColor: BENCH.line, color: BENCH.muted }}>
          This catalog row&apos;s spec no longer parses — the form cannot derive from it. The row is
          preserved; re-generate or edit from a valid row.
        </p>
      ) : (
        <>
          {/* ---- the organism, full stage ---- */}
          <section className="mt-8">
            <BenchLabel right="every pixel derives from a real parameter">The living form</BenchLabel>
            <div className="mt-3">
              <LabFormView
                harness={harness}
                memory={memory}
                runId={latest?.runId ?? null}
                role={me.role}
                surface="harness"
              />
            </div>
          </section>

          {/* ---- paperwork on the bench: the ledger stays paper ---- */}
          <LabPermissionLedger harnessHash={harness.harnessHash} role={me.role} />

          {/* ---- run it elsewhere: the OpenClaw wiring card ---- */}
          <section className="mt-8 border px-6 py-5" style={{ borderColor: BENCH.line, background: BENCH.raised }}>
            <BenchLabel right="same trust record, any runtime">Run this worker as an OpenClaw</BenchLabel>
            <p className="mt-3 max-w-2xl text-[13px] leading-relaxed" style={{ color: BENCH.muted }}>
              Add this to an OpenClaw plugin and every tool call routes through this worker&apos;s
              permission record: supervised actions ask in your own OpenClaw surface, earned classes
              run free with a standing audit sample — and there is no allow-always. Standing autonomy
              only ever comes from the grants above.
            </p>
            <pre
              className="mt-4 overflow-x-auto border px-4 py-3 font-mono text-[11.5px] leading-relaxed"
              style={{ borderColor: '#2a3346', background: BENCH.ground, color: '#c9d2e0' }}
            >
              {openClawSnippet}
            </pre>
          </section>

          {/* Step 10: the filament's control surface — connect heals, revoke cuts. */}
          {harness.spec.superpowers.length > 0 ? (
            <section className="mt-8">
              <BenchLabel>Connections</BenchLabel>
              <div className="mt-3">
                <ConnectorPanel />
              </div>
            </section>
          ) : null}
        </>
      )}
    </LabStage>
  );
}

// /share/b/[token] (H2, 2026-08-28) — THE ARTIFACT THAT ESCAPES. A worker's
// deliverable as a public page: typeset, frozen at mint (custody-scanned
// then, revocable now), footed with the labeled cost and the HONEST verify
// badge — "record verified" appears only when the replay theorem passed at
// mint. Every forwarded brief is a landing page: the footer names what made
// it and where to hire one.
import { notFound } from 'next/navigation';
import { BriefView } from '@/components/lab-brief';
import { apiUrl } from '@/lib/api';
import type { Brief } from '@potion/lab-spec';

export const dynamic = 'force-dynamic';

interface PublicBriefPayload {
  kind: 'brief';
  harnessName: string;
  brief: Brief;
  verified: boolean;
  judgeOverall: number | null;
  meteredUsd: number;
  estUsd: number;
  sharedAt: string;
}

async function loadPayload(token: string): Promise<PublicBriefPayload | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/public/share/${encodeURIComponent(token)}/brief`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as PublicBriefPayload;
  } catch {
    return null;
  }
}

export default async function SharedBriefPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = await loadPayload(token);
  if (payload === null) notFound();
  const cost =
    payload.meteredUsd > 0
      ? `$${payload.meteredUsd.toFixed(4)} metered`
      : `≈ $${payload.estUsd.toFixed(4)} est.`;
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-[1.4rem] font-semibold tracking-[-0.01em] text-ink">{payload.harnessName}</h1>
        <span className="font-mono text-[12px] text-faint">{new Date(payload.sharedAt).toLocaleDateString()}</span>
      </div>
      <BriefView brief={payload.brief} title="the deliverable" />
      <footer className="mt-5 border-t border-dashed border-[#d9d5cb] pt-3">
        <p className="font-mono text-[12.5px] text-soft" data-testid="escape-footer">
          produced by a Potion worker · {cost}
          {payload.judgeOverall !== null ? <> · scored {payload.judgeOverall}/10 by its judge (advisory)</> : null}
          {payload.verified ? <> · record verified ✓</> : null}
        </p>
        <p className="mt-1.5 text-[13px] text-soft">
          Every claim above carries its source; the worker that wrote it works under a hard budget
          and asks a human before any external action.{' '}
          <a href="https://withpotion.com/lab" className="text-accent underline">
            Hire a worker like this →
          </a>
        </p>
      </footer>
    </main>
  );
}

// /status (P2-10): "is it down?" answered self-serve, publicly. The
// dashboard container probes the API server-side on every load — no cache,
// no stored history, no green-by-default: if the probe fails, the page says
// so. History lives in the uptime watch (.github/workflows/uptime.yml, a
// GitHub Actions schedule that in practice fires a few times a day — the cron
// says 15 minutes, GitHub runs schedules best-effort and this one has averaged
// 5–7 runs/day since 2026-08-24); this page is the live answer.
import type { Metadata } from 'next';
import { SiteShell } from '@/components/site-header';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Potion status' };

async function probe(): Promise<{ api: boolean; latencyMs: number | null }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${apiUrl()}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return { api: res.ok, latencyMs: Date.now() - t0 };
  } catch {
    return { api: false, latencyMs: null };
  }
}

export default async function StatusPage() {
  const { api, latencyMs } = await probe();
  const checkedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return (
    <SiteShell>
      <main className="mx-auto max-w-2xl px-6 py-14">
        <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Live, checked on load</div>
        <h1 className="mt-2 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">
          {api ? 'All systems serving' : 'The API is not responding'}
        </h1>
        <p className="mt-2 text-[12px] text-faint">Checked {checkedAt} UTC · probes run from this page&rsquo;s server on every load, nothing cached.</p>

        <div className="mt-8 divide-y divide-[#d9d5cb] border border-[#d9d5cb] bg-[#fbfaf7]">
          <div className="flex items-baseline justify-between px-5 py-4">
            <div>
              <div className="text-[14px] text-ink">API — api.withpotion.com</div>
              <div className="mt-0.5 text-[12px] text-soft">Serving, routing, and the readiness check behind it (database included)</div>
            </div>
            <span className={`font-mono text-[12px] ${api ? 'text-accent' : 'text-warn'}`}>
              {api ? `operational · ${latencyMs}ms` : 'unreachable'}
            </span>
          </div>
          <div className="flex items-baseline justify-between px-5 py-4">
            <div>
              <div className="text-[14px] text-ink">Dashboard — withpotion.com</div>
              <div className="mt-0.5 text-[12px] text-soft">You are reading a page it just rendered</div>
            </div>
            <span className="font-mono text-[12px] text-accent">operational</span>
          </div>
        </div>

        <p className="mt-6 text-[13px] leading-relaxed text-soft">
          An independent watcher also probes both endpoints several times a day from outside
          our infrastructure and alerts us on failure. Seeing a problem this page doesn&rsquo;t?{' '}
          <a href="mailto:kavon@mutiny.ai" className="text-accent underline">kavon@mutiny.ai</a>.
        </p>
      </main>
    </SiteShell>
  );
}

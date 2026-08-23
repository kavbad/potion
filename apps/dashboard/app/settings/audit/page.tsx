// /settings/audit (M4 #34, SPEC §13.6) — unified org audit trail: custody
// (key lifecycle), auth events (logins/invites), incidents (guarantee),
// merged newest-first. Admin-only server-side; a 403 renders a notice, not
// a crash (a 401 is a dead session, and recovers through /api/auth/clear). The export form downloads a bounded (≤92-day) JSONL stream.
import { ApiUnreachable, isForbidden } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';

export const dynamic = 'force-dynamic';

interface AuditEventDto {
  ts: string;
  kind: string;
  actor: string;
  detail: unknown;
  ip: string | null;
  requestId: string | null;
}

interface AuditResponse {
  orgId: string;
  events: AuditEventDto[];
}

function detailPreview(detail: unknown): string {
  if (detail === null || detail === undefined) return '—';
  const s = JSON.stringify(detail);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const dflt = defaultRange();
  const from = params.from ?? dflt.from;
  const to = params.to ?? dflt.to;

  let data: AuditResponse;
  try {
    data = await fetchOrRecover<AuditResponse>('/api/audit');
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload.
          </div>
        </PageShell>
      );
    }
    // 403 — a session that resolved fine, belonging to someone whose role is
    // below admin. That is the notice this page has always meant to render.
    // It is deliberately NOT the 401 case: fetchOrRecover has already turned
    // a dead cookie into a redirect, and this catch must let that through.
    // Which is why the arm below rethrows rather than falling into the notice
    // as it used to — a blanket catch here would swallow Next's redirect
    // signal and show "you are not an admin" to someone who is simply signed
    // out, and would say the same thing about an API fault.
    if (isForbidden(e)) {
      return (
        <PageShell>
          <div className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
            The audit trail is admin-only. Sign in as an org admin to view custody, auth, and
            incident events — and to export the bounded JSONL archive.
          </div>
        </PageShell>
      );
    }
    throw e;
  }

  return (
    <PageShell>
      {/* export form — native GET navigation to the dashboard proxy, which
          streams the attachment through */}
      <form
        method="get"
        action="/api/audit/export.jsonl"
        className="mb-8 flex flex-wrap items-end gap-3"
      >
        <label className="text-xs text-faint">
          From
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="mt-1 block rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="text-xs text-faint">
          To
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="mt-1 block rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-line bg-paper px-4 py-2 text-sm text-soft transition-colors hover:text-ink"
        >
          Export JSONL
        </button>
        <span className="text-xs text-faint">bounded to a 92-day window</span>
      </form>

      <section className="border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">Recent events</h2>
          <span className="text-xs text-faint">latest {data.events.length}</span>
        </div>
        {data.events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
            No audit events yet. Key lifecycle actions, logins, and guarantee incidents land here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                <th className="py-2 pr-4 font-medium">Time</th>
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 pr-4 font-medium">Actor</th>
                <th className="py-2 pr-4 font-medium">Detail</th>
                <th className="py-2 text-right font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e, i) => (
                <tr key={`${e.ts}-${e.kind}-${i}`} className="border-b border-line last:border-0">
                  <td className="py-2 pr-4 whitespace-nowrap text-faint">
                    {new Date(e.ts).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="rounded bg-paper px-1.5 py-0.5 font-mono text-xs text-soft">
                      {e.kind}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-ink">{e.actor}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-faint">
                    {detailPreview(e.detail)}
                  </td>
                  <td className="py-2 text-right text-xs text-faint">{e.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-6 text-xs leading-relaxed text-faint">
          Custody rows predate per-request capture, so their ip/requestId columns are null. The
          export merges the same three sources into one ascending chronology, streamed line by
          line.
        </p>
      </section>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-5xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Audit trail</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Every sensitive thing that happened in your org: key custody, sign-ins, and guarantee
        incidents — one chronology, exportable as JSONL.
      </p>
      {children}
    </div>
  );
}

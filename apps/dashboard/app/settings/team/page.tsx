'use client';
// Team (P0-2, 2026-08-24): members, open invites, the invite form. An
// invite authorizes an email; the invitee accepts by signing in with it.
import { useCallback, useEffect, useState } from 'react';

interface Member { email: string; role: string; since: string }
interface Invite { id: string; email: string; role: string; invitedBy: string; createdAt: string; status: string }

export default function TeamPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [admin, setAdmin] = useState(true);

  const load = useCallback(async () => {
    const m = await fetch('/api/members', { cache: 'no-store' }).catch(() => null);
    if (m?.ok) setMembers(((await m.json()) as { members: Member[] }).members);
    const i = await fetch('/api/invites', { cache: 'no-store' }).catch(() => null);
    if (i?.ok) setInvites(((await i.json()) as { invites: Invite[] }).invites);
    else if (i?.status === 403) setAdmin(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    const res = await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim(), role }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setNotice(`Invited ${email.trim()} — they sign in with that address to accept. The invite is valid for 7 days.`); setEmail(''); void load(); }
    else setError(((await res?.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? 'invite failed');
  }
  async function revoke(id: string) {
    setBusy(true);
    await fetch(`/api/invites/${id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false); void load();
  }

  const open = invites.filter((i) => i.status === 'open');
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Settings · Team</div>
      <h1 className="mt-2 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Who can sign in</h1>
      <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-soft">
        Members sign in by magic link with their email. An invite authorizes an address; signing in with it accepts the invite.
      </p>

      <div className="mt-8 border border-[#d9d5cb] bg-[#fbfaf7]">
        <div className="border-b border-[#d9d5cb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Members</div>
        <ul className="divide-y divide-[#d9d5cb]">
          {members.map((m) => (
            <li key={m.email} className="flex items-baseline justify-between px-5 py-3 text-[13px]">
              <span className="text-ink">{m.email}</span>
              <span className="font-mono text-[11px] text-faint">{m.role} · since {m.since.slice(0, 10)}</span>
            </li>
          ))}
          {members.length === 0 && <li className="px-5 py-3 text-[13px] text-faint">Loading…</li>}
        </ul>
      </div>

      {admin && (
        <>
          <form onSubmit={invite} className="mt-6 flex flex-wrap items-end gap-3 border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
            <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-[0.14em] text-faint">
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="teammate@yourco.com"
                className="w-64 border border-[#d9d5cb] bg-white px-3 py-2 font-sans text-[13px] normal-case tracking-normal text-ink outline-none focus:border-accent" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-[0.14em] text-faint">
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)} className="border border-[#d9d5cb] bg-white px-3 py-2 font-sans text-[13px] normal-case tracking-normal text-ink outline-none">
                <option value="member">member</option>
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit" disabled={busy} className="bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40">
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          </form>
          {error && <p className="mt-2 text-[12px] text-warn">{error}</p>}
          {notice && <p className="mt-2 text-[12px] text-accent">{notice}</p>}

          {open.length > 0 && (
            <div className="mt-6 border border-[#d9d5cb] bg-[#fbfaf7]">
              <div className="border-b border-[#d9d5cb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Open invites</div>
              <ul className="divide-y divide-[#d9d5cb]">
                {open.map((i) => (
                  <li key={i.id} className="flex items-baseline justify-between px-5 py-3 text-[13px]">
                    <span className="text-ink">{i.email} <span className="font-mono text-[11px] text-faint">as {i.role}</span></span>
                    <button type="button" onClick={() => void revoke(i.id)} disabled={busy} className="border border-[#d9d5cb] px-3 py-1 text-[12px] text-ink hover:opacity-80 disabled:opacity-40">
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

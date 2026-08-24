'use client';

// R0: what this month costs, the card on file, and every past charge.
// When no payment rails are configured the page says exactly that rather
// than showing an Add-card button that cannot work.
import { useCallback, useEffect, useState } from 'react';

interface BillingState {
  period: string;
  current: { totalUsd: number; requests: number; lineItems: Array<{ clusterId: string; description: string; requests: number; totalUsd: number }> };
  paymentMethod: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  transport: 'stripe' | 'ledger';
  charges: Array<{ period: string; amountUsd: number; status: string; transport: string; at: string }>;
}

const usd = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function BillingCard() {
  const [data, setData] = useState<BillingState | null>(null);
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [me, b] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/billing', { cache: 'no-store' }).catch(() => null),
    ]);
    if (me?.ok) setRole(((await me.json()) as { role?: string }).role ?? 'viewer');
    if (b?.ok) setData((await b.json()) as BillingState);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function addCard() {
    setBusy(true); setError(null);
    const res = await fetch('/api/billing/payment-method', { method: 'POST' }).catch(() => null);
    setBusy(false);
    if (!res?.ok) { setError('Could not start checkout.'); return; }
    const body = (await res.json()) as { url: string; transport: string };
    if (body.transport === 'stripe') window.location.href = body.url;
    else setError('Payments are not switched on yet — no card can be added.');
  }

  if (!data) return null;
  const admin = role === 'admin';
  const live = data.transport === 'stripe';

  return (
    <>
      <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">This month</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{data.period}</span>
        </div>
        <div className="flex items-baseline gap-4">
          <span className="text-[2.4rem] font-medium tracking-[-0.02em] text-ink">{usd(data.current.totalUsd)}</span>
          <span className="text-sm text-soft">
            {data.current.requests.toLocaleString()} request{data.current.requests === 1 ? '' : 's'} served so far
          </span>
        </div>
        {data.current.lineItems.length > 0 && (
          <ul className="mt-5 divide-y divide-line border-t border-line">
            {data.current.lineItems.map((l) => (
              <li key={l.clusterId} className="flex items-baseline justify-between py-2 text-[13px]">
                <span className="text-soft">{l.description}</span>
                <span className="font-mono text-ink">{usd(l.totalUsd)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs leading-relaxed text-faint">
          You pay for the requests we serve, at the prices in your receipts. This figure is the invoice
          — not an estimate of it.
        </p>
      </section>

      <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
        <h2 className="mb-3 text-lg font-medium text-ink">Payment method</h2>
        {!live ? (
          <p className="max-w-xl text-sm leading-relaxed text-soft">
            Payments are not switched on yet, so nothing is being charged. Your usage is still measured
            and invoiced exactly as it will be billed — you can see the numbers above.
          </p>
        ) : data.paymentMethod ? (
          <p className="text-sm text-ink">
            {data.paymentMethod.brand} ending {data.paymentMethod.last4}
            <span className="text-soft"> · expires {data.paymentMethod.expMonth}/{data.paymentMethod.expYear}</span>
          </p>
        ) : (
          <p className="text-sm text-soft">No card on file.</p>
        )}
        {admin && live && (
          <button
            type="button"
            onClick={() => void addCard()}
            disabled={busy}
            className="mt-4 bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Opening…' : data.paymentMethod ? 'Replace card' : 'Add a card'}
          </button>
        )}
        {error && <p className="mt-3 text-xs text-warn">{error}</p>}
      </section>

      {data.charges.length > 0 && (
        <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
          <h2 className="mb-3 text-lg font-medium text-ink">History</h2>
          <ul className="divide-y divide-line">
            {data.charges.map((c) => (
              <li key={c.period} className="flex items-baseline justify-between py-2 text-[13px]">
                <span className="text-ink">{c.period}</span>
                <span className="flex items-baseline gap-3">
                  <span className="font-mono text-ink">{usd(c.amountUsd)}</span>
                  <span className="font-mono text-[11px] uppercase tracking-wide text-faint">
                    {c.status === 'recorded' ? 'recorded · not charged' : c.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

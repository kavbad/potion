'use client';

// Model-field semantics (migration 0058, external review 2026-08-25).
// Default: 'potion-auto' routes, a named model pins, an unknown name 400s.
// Migration mode routes every label — an explicit, visible choice here,
// never a silent default.
import { useEffect, useState } from 'react';

export function ModelSemantics() {
  const [routeAll, setRouteAll] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/org-settings', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { routeAllModels?: boolean } | null) => setRouteAll(b?.routeAllModels === true))
      .catch(() => setRouteAll(false));
  }, []);
  async function save(value: boolean) {
    setBusy(true);
    const res = await fetch('/api/org-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeAllModels: value }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) setRouteAll(value);
  }
  if (routeAll === null) return null;
  return (
    <section className="mt-8 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-6">
      <h2 className="mb-1 text-lg font-medium text-ink">What the model field means</h2>
      <p className="mb-4 text-[13px] leading-relaxed text-soft">
        By default, <code className="font-mono">potion-auto</code> routes by measurement, naming a
        real model serves exactly that model, and an unknown name is an error — your model strings
        keep meaning what they say.
      </p>
      <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-soft">
        <input
          type="checkbox"
          checked={routeAll}
          disabled={busy}
          onChange={(e) => void save(e.target.checked)}
          className="mt-1 h-3.5 w-3.5 accent-[#1c1a17]"
        />
        <span>
          <span className="font-medium text-ink">Migration mode: route every model name.</span>{' '}
          Treat any model string as <code className="font-mono">potion-auto</code> — for apps whose
          model strings you cannot change yet. The receipt always names what actually served.
        </span>
      </label>
    </section>
  );
}

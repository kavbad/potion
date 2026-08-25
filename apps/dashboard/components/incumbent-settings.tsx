'use client';

// The settings home for "what do you use today". The first-run gate promises
// "change anytime in Settings"; until the 2026-08-24 surface review the
// picker only existed inside the home-page onboarding island, so the promise
// pointed at nothing. Thin client wrapper: fetch current, render the picker.
import { useEffect, useState } from 'react';
import { IncumbentPicker, type Incumbents } from '@/components/incumbent-picker';

export function IncumbentSettings() {
  const [state, setState] = useState<{ loaded: boolean; initial: Incumbents | null }>({ loaded: false, initial: null });
  useEffect(() => {
    fetch('/api/incumbents', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Incumbents | null) => setState({ loaded: true, initial: b }))
      .catch(() => setState({ loaded: true, initial: null }));
  }, []);
  if (!state.loaded) return null;
  return (
    <section className="mt-8 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-6">
      <h2 className="mb-1 text-lg font-medium text-ink">What you use today</h2>
      <p className="mb-4 text-[13px] leading-relaxed text-soft">
        The baseline your quality bar is measured against — and the sampling consent that lets
        Potion measure your actual work.
      </p>
      <IncumbentPicker initial={state.initial} />
    </section>
  );
}

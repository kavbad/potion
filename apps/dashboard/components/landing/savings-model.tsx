'use client';

// THE SAVINGS MODEL — the one artefact a non-technical reader can drive.
//
// Two inputs a buyer already understands: how much you spend on AI, and how
// good the answers have to be. Everything else is computed from the committed
// frontier using the compiler's real min_cost rule (lib/economics.ts), so this
// is a model of measured points, not a marketing calculator with invented
// multipliers.
//
// The design decision that matters: workloads Potion CANNOT help with are
// rendered, not hidden. Drag the quality bar up and watch categories go grey
// and the headline number fall. A calculator that always says "you save 50%"
// is a calculator nobody believes; one that says "not this one, and here is
// why" is doing the same job the product does.
import { useMemo, useState } from 'react';
import { blendedSavingPct, savingsAt } from '@/lib/economics';

const SPENDS = [10_000, 50_000, 250_000, 1_000_000];

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

export function SavingsModel() {
  const [floor, setFloor] = useState(0.8);
  const [spend, setSpend] = useState(50_000);

  const rows = useMemo(() => savingsAt(floor), [floor]);
  const blended = useMemo(() => blendedSavingPct(rows), [rows]);
  const served = rows.filter((r) => !r.unmet);
  const unmet = rows.filter((r) => r.unmet);
  const annualSpend = spend * 12;
  const annual = annualSpend * (blended / 100);

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent/70" />
        savings model · runs the real selection rule, live
      </div>
      {/* ---- inputs ---- */}
      <div className="grid gap-6 border-b border-line px-6 py-6 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-faint">
            What you spend on AI each month
          </label>
          <p className="mt-1 text-xs text-faint">
            {money(spend)} a month is {money(spend * 12)} a year.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SPENDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpend(s)}
                className={`rounded-md px-3 py-1.5 font-mono text-xs transition-colors ${
                  spend === s ? 'bg-accent text-white' : 'bg-paper text-soft hover:text-ink'
                }`}
              >
                {money(s)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-faint">
            How good the answers must be
          </label>
          <div className="mt-3 flex items-center gap-3">
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={floor}
              onChange={(e) => setFloor(Number(e.target.value))}
              className="flex-1 accent-[#0f766e]"
              aria-label="Minimum measured quality"
            />
            <span className="w-10 shrink-0 text-right font-mono text-sm text-ink">
              {floor.toFixed(2)}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-faint">
            Measured quality, 0 to 1 — the floor Potion is never allowed to go below.
          </p>
        </div>
      </div>

      {/* ---- headline ---- */}
      <div className="grid gap-px bg-line sm:grid-cols-2">
        <div className="bg-panel px-6 py-7">
          <div className="text-xs uppercase tracking-wide text-faint">Cut from your AI bill</div>
          <div className="mt-2 font-mono text-4xl font-medium tabular-nums text-accent">
            {blended.toFixed(0)}%
          </div>
          <div className="mt-2 flex items-end" aria-hidden>
            <span className="h-px w-12 bg-accent/60" />
            <span className="h-[6px] w-px bg-accent/60" />
          </div>
          <div className="mt-1 text-xs text-faint">
            versus running the best model on everything
          </div>
        </div>
        {/* TIME BASES MUST MATCH. This card used to read "$296k saved per
            year" over "on $50k a month" — arithmetically right (50k x 12 x
            49%) and unreadable, because a yearly figure sitting above a
            monthly one looks like saving six times what you spend. The
            before/after is stated in one base instead, so a reader can check
            it in their head: the two numbers below add up to the first. */}
        <div className="bg-panel px-6 py-7">
          <div className="text-xs uppercase tracking-wide text-faint">Saved per year</div>
          <div className="mt-2 font-mono text-4xl font-medium tabular-nums text-ink">{money(annual)}</div>
          <div className="mt-1 text-xs text-faint">
            {money(annualSpend)} a year becomes {money(annualSpend - annual)}
          </div>
        </div>
      </div>

      {/* ---- per-workload breakdown ---- */}
      <div className="border-t border-line px-6 py-6">
        <div className="mb-4 text-xs uppercase tracking-wide text-faint">
          Where the saving comes from
        </div>
        <div className="space-y-2.5">
          {[...served]
            .sort((a, b) => (b.savedPct ?? 0) - (a.savedPct ?? 0))
            .map((r) => (
              <div key={r.cluster.id} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-0.5 transition-colors hover:bg-paper">
                <div className="w-52 shrink-0 truncate text-sm text-soft">{r.cluster.name}</div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-paper">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300"
                    style={{ width: `${Math.max(1, r.savedPct ?? 0)}%` }}
                  />
                </div>
                <div className="w-12 shrink-0 text-right font-mono text-xs text-ink">
                  {(r.savedPct ?? 0).toFixed(0)}%
                </div>
              </div>
            ))}
          {unmet.map((r) => (
            <div key={r.cluster.id} className="flex items-center gap-3 opacity-55">
              <div className="w-52 shrink-0 truncate text-sm text-faint line-through">
                {r.cluster.name}
              </div>
              <div className="flex-1 text-xs text-warn">
                nothing we have measured is this good — we would not take your traffic
              </div>
            </div>
          ))}
        </div>

        {/* the honest footnote, which is the point */}
        <p className="mt-6 max-w-2xl text-xs leading-relaxed text-faint">
          Some rows sit at or near zero and that is the model working. On multi-step reasoning the
          cheap options measure 0.46 against 0.98 for the expensive one — so Potion pays for the
          expensive one and saves you nothing there. Half the categories carry most of the saving;
          being told which half is the product.
        </p>
        <p className="mt-3 max-w-2xl text-xs leading-relaxed text-faint">
          Computed live from Potion&apos;s own measurements, against a baseline of running the
          highest-quality model on everything. It weights every kind of work equally — a real bill
          depends on your traffic mix, which is the first thing Potion measures once you connect.
        </p>
      </div>
    </div>
  );
}


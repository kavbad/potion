'use client';

// THE MEASURED FRONTIER, as a table you can sort.
//
// WHY THIS REPLACED THREE CARDS. The cards offered one strategy per priority
// — cheapest / best / fastest — and on real data they regularly collapsed:
// min_cost above a floor and max_quality under a ceiling select the SAME
// point whenever the frontier is short, so two cards showed identical numbers
// and read as a bug. Worse, three cards hid the thing the measurement
// actually bought: the shape of the trade-off. Every non-dominated strategy
// is here, and the columns the user cares about sort.
//
// WHAT "USE THIS" BINDS, and why it is not a pinned model. Potion routes by
// POLICY, not by model id — that is the whole product. So a row binds
// `min_cost` at that row's own quality, which selects it exactly today and,
// when something better gets measured later, moves you to that instead. The
// copy says so, because a table of model names invites exactly the opposite
// assumption.
import { useMemo, useState } from 'react';
import type { PlanResponse } from '@/lib/types';

type Row = PlanResponse['frontier'][number];
type SortKey = 'quality' | 'cost' | 'speed';

const PRIORITY_LABEL: Record<'cost' | 'quality' | 'speed', string> = {
  cost: 'cheapest',
  quality: 'best quality',
  speed: 'fastest',
};

export function FrontierTable({
  plan,
  onApply,
  busy,
  chosenHash,
}: {
  plan: PlanResponse;
  onApply: (row: {
    policy: Row['policy'];
    strategy: string;
    strategyHash: string;
    description: string;
  }) => void;
  busy: boolean;
  chosenHash: string | null;
}) {
  const [sort, setSort] = useState<SortKey>('quality');
  const [asc, setAsc] = useState(false);

  const rows = useMemo(() => {
    const copy = [...plan.frontier];
    copy.sort((a, b) => {
      const d =
        sort === 'quality'
          ? a.quality - b.quality
          : sort === 'cost'
            ? a.costPer1K - b.costPer1K
            : a.latencyP95 - b.latencyP95;
      // Deterministic tie-break so re-sorting never shuffles equal rows.
      return (asc ? d : -d) || a.strategy.localeCompare(b.strategy);
    });
    return copy;
  }, [plan.frontier, sort, asc]);

  function header(key: SortKey, label: string, hint: string) {
    const active = sort === key;
    return (
      <th className="px-4 py-2 text-right font-medium">
        <button
          type="button"
          title={hint}
          onClick={() => {
            if (active) setAsc((v) => !v);
            else {
              setSort(key);
              // Sensible first direction: best quality first, cheapest first,
              // fastest first — nobody's first click means "show me the worst".
              setAsc(key !== 'quality');
            }
          }}
          className={`inline-flex items-center gap-1 transition-colors ${
            active ? 'text-ink' : 'text-faint hover:text-soft'
          }`}
        >
          {label}
          <span aria-hidden className="text-[9px]">
            {active ? (asc ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs">
            <tr>
              <th className="px-4 py-2 font-medium text-faint">Strategy</th>
              {header('quality', 'Quality', 'Measured score against a reference answer')}
              {header('cost', 'Cost / 1k', 'USD per 1,000 requests')}
              {header('speed', 'Speed (p95)', 'Provisional: measured on evaluation runs')}
              <th className="px-4 py-2 text-right font-medium text-faint">vs. best</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const chosen = chosenHash === r.strategyHash;
              return (
                <tr key={r.strategyHash} className={chosen ? 'bg-accent-soft' : undefined}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-ink">{r.strategy}</div>
                    {r.selectedBy.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.selectedBy.map((p) => (
                          <span
                            key={p}
                            className="rounded-full border border-line bg-paper px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-soft"
                          >
                            {PRIORITY_LABEL[p]}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-ink">
                    {r.quality.toFixed(3)}
                    {r.qualityCi95!== null && (
                      <span className="text-faint"> ±{r.qualityCi95.toFixed(3)}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-ink">
                    ${r.costPer1K.toFixed(4)}
                    <div className="text-[10px] text-faint">
                      ${(r.costPer1K / 1000).toFixed(6)}/req
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-ink">
                    {Math.round(r.latencyP95).toLocaleString()} ms
                    {r.latencyProvisional && <span className="text-warn"> *</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {r.savedVsBestQuality === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className="font-medium text-emerald-700">
                        {(r.savedVsBestQuality * 100).toFixed(0)}% less
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.policy === null ? (
                      // No rule isolates this row (it survives only on a
                      // dimension the policy shapes cannot express). Saying so
                      // beats a button that silently binds something else.
                      <span
                        className="text-xs text-faint"
                        title="No policy rule selects this strategy specifically — pick a neighbouring row."
                      >
                        not bindable
                      </span>
                    ) : (
                    <button
                      onClick={() =>
                        onApply({
                          policy: r.policy!,
                          strategy: r.strategy,
                          strategyHash: r.strategyHash,
                          description: `Potion will keep serving the cheapest strategy measured at quality ${r.quality.toFixed(3)} or better.`,
                        })
                      }
                      disabled={busy}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50 ${
                        chosen
                          ? 'bg-accent text-white'
                          : 'border border-line bg-panel text-ink hover:border-accent hover:text-accent'
                      }`}
                    >
                      {chosen ? 'Applied ✓' : 'Use this'}
                    </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-faint">
        Choosing a row binds a <span className="font-medium text-soft">policy</span>, not a model:
        “the cheapest strategy at this quality or better”. It serves the row you picked today, and
        if Potion later measures something that beats it, you get that instead — without changing
        a line of your code. <span className="text-warn">*</span> latency is provisional until your
        own traffic measures it.
      </p>
    </div>
  );
}

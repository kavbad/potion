// Savings bar chart: actual vs projected spend (M3 #21 shadow mode,
// SPEC §12.4). Hand-rolled SVG — server-rendered, zero client JS (design-
// language match with components/usage-chart.tsx; the mapping lives in
// lib/savings-chart.ts).
import type { SavingsReportDto } from '@/lib/types';
import { buildSavingsBars, type SavingsBars } from '@/lib/savings-chart';
import { formatUsd } from '@/lib/usage-chart';

const W = 720;
const H = 240;
const PAD_L = 56;
const PAD_R = 8;
const PAD_T = 24;
const PAD_B = 40;

export function SavingsChart({ report }: { report: SavingsReportDto }) {
  const data = buildSavingsBars(report);
  if (data.bars.length <= 1) {
    // actual-only: no shadow evidence in the window
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
        No shadow samples in this window yet. Attach a{' '}
        <code className="font-mono">shadow</code> block to a policy and serve some traffic — the
        candidates Potion replays will show up here as projected spend.
      </div>
    );
  }
  return (
    <div>
      <Bars data={data} />
      <p className="mt-4 text-xs text-faint">
        Violet is what you actually spent; each muted bar is a shadowed candidate&apos;s projected
        spend over the same window. Hover a bar for details.
      </p>
    </div>
  );
}

function Bars({ data }: { data: SavingsBars }) {
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(data.maxSpend, 1e-9);
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const n = data.bars.length;
  const slot = plotW / n;
  const barW = Math.min(72, slot * 0.56);
  // ~4 horizontal gridlines with nice-ish steps
  const step = max / 4;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-12; v += step) ticks.push(v);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Actual vs projected spend by shadowed candidate"
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--color-line, #e5e2db)"
            strokeWidth={1}
          />
          <text
            x={PAD_L - 8}
            y={y(t) + 4}
            textAnchor="end"
            fontSize={11}
            fill="var(--color-faint, #a8a29a)"
          >
            {formatUsd(t)}
          </text>
        </g>
      ))}
      {data.bars.map((bar, i) => {
        const cx = PAD_L + slot * i + slot / 2;
        const height = Math.max(0, y(0) - y(bar.spendUsd));
        return (
          <g key={bar.key}>
            <rect x={cx - barW / 2} y={y(bar.spendUsd)} width={barW} height={height} fill={bar.color} rx={2}>
              <title>
                {bar.deltaUsd === null
                  ? `${bar.label}: ${formatUsd(bar.spendUsd)}`
                  : `${bar.label}: ${formatUsd(bar.spendUsd)} projected · ${
                      bar.deltaUsd >= 0 ? 'saves' : 'costs'
                    } ${formatUsd(Math.abs(bar.deltaUsd))}`}
              </title>
            </rect>
            <text
              x={cx}
              y={y(bar.spendUsd) - 6}
              textAnchor="middle"
              fontSize={11}
              fill="var(--color-soft, #6b6560)"
            >
              {formatUsd(bar.spendUsd)}
            </text>
            <text
              x={cx}
              y={H - 20}
              textAnchor="middle"
              fontSize={11}
              fill="var(--color-faint, #a8a29a)"
            >
              {bar.axisLabel}
            </text>
            <text
              x={cx}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-faint, #a8a29a)"
            >
              {bar.kind === 'actual' ? 'what you spent' : 'projected'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

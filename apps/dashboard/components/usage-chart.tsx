// Stacked bar chart: requests/day by cluster (M2 Wave 2, ROADMAP #17/#18).
// Hand-rolled SVG — server-rendered, zero client JS (design-language match
// with the rest of the dashboard; the mapping lives in lib/usage-chart.ts).
import type { UsageDayRowDto } from '@/lib/types';
import { buildUsageStacks, clusterColor, formatDay, type UsageStacks } from '@/lib/usage-chart';

const W = 720;
const H = 220;
const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 28;

export function UsageChart({ rows }: { rows: UsageDayRowDto[] }) {
  const stacks = buildUsageStacks(rows);
  if (stacks.bars.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
        No rolled-up usage in this window yet. Run the rollup (below) or wait for the nightly job.
      </div>
    );
  }
  return (
    <div>
      <StackedBars stacks={stacks} />
      <Legend stacks={stacks} />
    </div>
  );
}

function StackedBars({ stacks }: { stacks: UsageStacks }) {
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, stacks.maxTotal);
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const n = stacks.bars.length;
  const slot = plotW / n;
  const barW = Math.min(48, slot * 0.62);
  // ~4 horizontal gridlines with nice-ish integer steps
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Requests per day by cluster">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--color-line, #e5e2db)" strokeWidth={1} />
          <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-faint, #a8a29a)">
            {t}
          </text>
        </g>
      ))}
      {stacks.bars.map((bar, i) => {
        const cx = PAD_L + slot * i + slot / 2;
        return (
          <g key={bar.day}>
            {bar.segments.map((seg) => (
              <rect
                key={seg.clusterId}
                x={cx - barW / 2}
                y={y(seg.y1)}
                width={barW}
                height={Math.max(0, y(seg.y0) - y(seg.y1))}
                fill={seg.color}
              >
                <title>{`${formatDay(bar.day)} · ${seg.clusterId}: ${seg.requests} requests`}</title>
              </rect>
            ))}
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              fontSize={11}
              fill="var(--color-faint, #a8a29a)"
            >
              {n > 20 && i % 2 === 1 ? '' : formatDay(bar.day)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Legend({ stacks }: { stacks: UsageStacks }) {
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      {stacks.clusters.map((c) => (
        <span key={c} className="flex items-center gap-1.5 text-xs text-soft">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: clusterColor(c, stacks.clusters) }}
          />
          {c}
        </span>
      ))}
    </div>
  );
}

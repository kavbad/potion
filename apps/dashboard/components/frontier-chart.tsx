'use client';

// THE MONEY SHOT (SPEC §9): one accent color, warm neutrals, no gradients,
// labeled axes with units, plain-language quality ticks, dot size = p95
// latency, dominated region shaded, step line through the frontier points,
// "you are here" marker. Fixed size (not ResponsiveContainer) so the SVG is
// server-rendered into the page HTML.
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceDot,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  QUALITY_TICKS,
  Y_DOMAIN,
  describeStrategy,
  dominatedRects,
  formatDollars,
  qualityWord,
  toChartPoints,
  xDomain,
  type ChartPoint,
} from '@/lib/frontier-chart';
import type { Policy } from '@potion/core';
import type { FrontierPointDto, FrontierResponse, OperatingPointDto } from '@/lib/types';

const COLORS = {
  accent: '#0f766e', // teal-700 — the one accent (frontier line + dots)
  ink: '#292524',
  faint: '#a8a29e',
  grid: '#e7e2da',
  dominated: '#e7e2da', // warm neutral wash — no gradients
};

// recharts custom shape props leak internals; we only need cx/cy + payload.
interface ShapeProps {
  cx?: number;
  cy?: number;
  payload?: ChartPoint;
}

/** Frontier dot — radius scales with p95 latency (legend below says so). */
function FrontierDot(props: ShapeProps) {
  const { cx = 0, cy = 0, payload } = props;
  const r = payload?.r ?? 6;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={COLORS.accent}
      fillOpacity={0.9}
      stroke="#ffffff"
      strokeWidth={1.5}
    />
  );
}

function HoverCard({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]!.payload;
  return (
    <div className="max-w-xs rounded-lg border border-line bg-panel px-4 py-3 shadow-sm">
      <div className="text-sm font-medium text-ink">{p.label}</div>
      <dl className="mt-2 space-y-1 text-xs text-soft">
        <div className="flex justify-between gap-6">
          <dt>Quality</dt>
          <dd className="font-medium text-ink">
            {qualityWord(p.quality)} ({p.quality.toFixed(2)})
          </dd>
        </div>
        <div className="flex justify-between gap-6">
          <dt>Cost per 1K requests</dt>
          <dd className="font-medium text-ink">{formatDollars(p.costPer1K)}</dd>
        </div>
        <div className="flex justify-between gap-6">
          <dt>p95 latency</dt>
          <dd className="font-medium text-ink">{Math.round(p.latencyP95)} ms</dd>
        </div>
      </dl>
    </div>
  );
}

export function FrontierChart({ data }: { data: FrontierResponse }) {
  const points = toChartPoints(data.frontier.points);
  const op = data.operatingPoint;
  const [xMin, xMax] = xDomain(points, op ? [op.costPer1K] : []);
  const rects = dominatedRects(points, xMax);

  return (
    <div>
      <ScatterChart width={780} height={460} margin={{ top: 24, right: 40, bottom: 44, left: 16 }}>
        <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          type="number"
          dataKey="x"
          domain={[xMin, xMax]}
          tickFormatter={formatDollars}
          tick={{ fill: COLORS.faint, fontSize: 12 }}
          stroke={COLORS.grid}
          label={{
            value: 'Cost per 1K requests (USD)',
            position: 'insideBottom',
            offset: -32,
            fill: COLORS.faint,
            fontSize: 12,
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          domain={Y_DOMAIN}
          ticks={QUALITY_TICKS.map((t) => t.value)}
          tickFormatter={(v: number) => qualityWord(v)}
          tick={{ fill: COLORS.faint, fontSize: 12 }}
          stroke={COLORS.grid}
          width={112}
          label={{
            value: 'Answer quality',
            angle: -90,
            position: 'insideLeft',
            offset: 4,
            fill: COLORS.faint,
            fontSize: 12,
          }}
        />

        {/* dominated region — shaded under/left of the frontier step line */}
        {rects.map((r, i) => (
          <ReferenceArea
            key={i}
            x1={r.x1}
            x2={r.x2}
            y1={r.y1}
            y2={r.y2}
            fill={COLORS.dominated}
            fillOpacity={0.45}
            stroke="none"
            ifOverflow="hidden"
          />
        ))}

        <Tooltip content={<HoverCard />} cursor={{ strokeDasharray: '4 4', stroke: COLORS.faint }} />

        {/* frontier: step line through the points worth paying for */}
        <Scatter
          data={points}
          line={{ stroke: COLORS.accent, strokeWidth: 2 }}
          lineJointType="stepAfter"
          shape={<FrontierDot />}
          isAnimationActive={false}
        />

        {/* "You are here" — the customer's current operating point */}
        {op && (
          <ReferenceDot
            x={op.costPer1K}
            y={op.quality}
            r={11}
            fill="none"
            stroke={COLORS.ink}
            strokeWidth={2.5}
            ifOverflow="extendDomain"
            label={{
              value: `You are here · quality ${op.quality.toFixed(3)} · ${formatDollars(op.costPer1K)}/1K`,
              position: 'top',
              fill: COLORS.ink,
              fontSize: 12,
              fontWeight: 600,
            }}
          />
        )}
      </ScatterChart>

      {op && <WhyThisPoint op={op} points={data.frontier.points} />}

      {/* legend — plain language, per the design brief */}
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-faint">
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-6 bg-accent" /> frontier — points worth paying for
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-accent opacity-90" />
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent opacity-90" />
          dot size = p95 latency (bigger = slower)
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-ink" />
          you are here
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-4 bg-line" /> shaded = beaten by the line
        </span>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// WHY THIS POINT (2026-08-25, operator question rendered as product: "why are
// we using the most expensive model based on the chart"). The marker is
// selectPoint(policy) — the compiler obeying the org's own rule — but the chart
// compresses thousandths of quality into one visual band, so a max-quality
// pick LOOKS like buying the same quality for more money. The page must say
// what the rule chose and what the alternative costs; a chart that leaves the
// owner asking "why" has failed at its one job.

function ruleInWords(policy: Policy): string {
  switch (policy.type) {
    case 'max_quality':
      return `highest measured quality under $${policy.costCeilingPer1K.toFixed(2)}/1K`;
    case 'min_cost':
      return `cheapest point at or above your ${policy.qualityFloor.toFixed(2)} bar`;
    case 'latency_bound':
      return `highest quality within ${policy.p95Ms} ms p95`;
    case 'compound':
      return `cheapest above your ${policy.qualityFloor.toFixed(2)} bar within ${policy.p95Ms} ms p95`;
  }
}

function WhyThisPoint({ op, points }: { op: OperatingPointDto; points: FrontierPointDto[] }) {
  const floor =
    op.policy.type === 'min_cost' || op.policy.type === 'compound' ? op.policy.qualityFloor : null;
  // The alternative worth naming: the cheapest point that clears the bar
  // (or the cheapest point at all when the rule has no bar).
  const qualifying = points.filter((pt) => (floor === null ? true : pt.quality >= floor));
  const cheapest = qualifying.reduce<FrontierPointDto | null>(
    (best, pt) => (best === null || pt.costPer1K < best.costPer1K ? pt : best),
    null,
  );
  const isCheapest = cheapest !== null && cheapest.strategyHash === op.strategyHash;
  return (
    <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-soft">
      <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">why this point · </span>
      Your rule is <span className="font-medium text-ink">{ruleInWords(op.policy)}</span>
      {op.fallback === 1 ? ' — no point qualified, so this is the fallback serve' : ''}.{' '}
      {isCheapest ? (
        <>This is already the cheapest point that qualifies.</>
      ) : cheapest !== null && cheapest.costPer1K < op.costPer1K ? (
        <>
          The cheapest {floor !== null ? 'point above your bar' : 'point on the line'} is{' '}
          <span className="font-medium text-ink">{describeStrategy(cheapest.strategyConfig)}</span> at{' '}
          {formatDollars(cheapest.costPer1K)}/1K — measured quality {cheapest.quality.toFixed(3)} vs{' '}
          {op.quality.toFixed(3)} here ({(op.quality - cheapest.quality) >= 0 ? '−' : '+'}
          {Math.abs(op.quality - cheapest.quality).toFixed(3)}). Your rule prefers quality, so it buys
          this one; switch the rule in{' '}
          <a href="/settings/controls" className="text-accent underline">Controls</a> to take the cheaper point.
        </>
      ) : null}
    </p>
  );
}

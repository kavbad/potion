// THE GUARD THAT MAKES THE LANDING PAGE'S STALENESS LOUD.
//
// The landing page quotes committed evidence, on purpose: it must render with
// no session and no API server. The failure that doctrine allowed (found
// 2026-09-04) is that nobody re-quotes. The page said "measured 2026-08-20"
// while the frontier behind it was created 2026-08-21 and two other clusters
// had republished on 2026-09-03; it said 270x against a measured 270.9x, and
// 99% quality retained against a measured 97.8%.
//
// These tests recompute the page's numbers from the baseline INDEPENDENTLY of
// the generator — deliberately not by re-running it, so a bug in the
// generator cannot agree with itself — and fail when the shipped file and the
// evidence disagree. Regenerate with:
//
//   pnpm --filter @potion/dashboard gen:evidence
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINE_META, CLUSTERS, CODE_GEN, EVIDENCE } from '../lib/evidence.generated';

const REPO = resolve(__dirname, '../../..');
const baseline = JSON.parse(
  readFileSync(resolve(REPO, 'packages/db/baseline/platform-frontiers.json'), 'utf8'),
) as {
  capturedAt: string;
  frontiers: Array<{
    frontier: {
      cluster_id: string;
      version: number;
      created_at: string;
      points: Array<{
        quality: number;
        costPer1K: number;
        strategyConfig: Record<string, unknown>;
        evidence?: { n?: number };
      }>;
    };
  }>;
};

/** The same secret the server's incumbent roster protects. */
const WITHHELD = /solar|upstage/i;

describe('the landing page quotes the baseline it ships with', () => {
  it('every cluster carries the baseline frontier version and creation date', () => {
    for (const { frontier: f } of baseline.frontiers) {
      const shipped = CLUSTERS[f.cluster_id];
      expect(shipped, `cluster ${f.cluster_id} missing from the generated evidence`).toBeDefined();
      expect(shipped!.version, `${f.cluster_id} version`).toBe(f.version);
      expect(shipped!.measuredAt, `${f.cluster_id} measured date`).toBe(f.created_at.slice(0, 10));
      expect(shipped!.points.length, `${f.cluster_id} point count`).toBe(f.points.length);
    }
    expect(Object.keys(CLUSTERS).length).toBe(baseline.frontiers.length);
  });

  it('the freshness stamp names the newest frontier in the baseline', () => {
    const newest = baseline.frontiers
      .map(({ frontier: f }) => f.created_at.slice(0, 10))
      .sort()
      .at(-1);
    expect(BASELINE_META.newestMeasuredAt).toBe(newest);
    expect(BASELINE_META.capturedAt).toBe(baseline.capturedAt.slice(0, 10));
  });

  it('Figure 3 computes its own headline from the rows it draws', () => {
    const cg = baseline.frontiers.find((f) => f.frontier.cluster_id === 'code-gen')!.frontier;
    const costs = cg.points.map((p) => p.costPer1K).sort((a, b) => a - b);
    const cheapest = cg.points.find((p) => p.costPer1K === costs[0])!;
    const dearest = cg.points.find((p) => p.costPer1K === costs.at(-1))!;

    expect(CODE_GEN.measuredAt).toBe(cg.created_at.slice(0, 10));
    expect(CODE_GEN.ratio).toBe(Math.round(dearest.costPer1K / cheapest.costPer1K));
    expect(CODE_GEN.qualityGapPoints).toBeCloseTo((dearest.quality - cheapest.quality) * 100, 1);
    // Quality retained may understate, never overstate — the 99%-vs-97.8% bug.
    const trueRetained = (cheapest.quality / dearest.quality) * 100;
    expect(CODE_GEN.qualityRetainedPct).toBeLessThanOrEqual(trueRetained);
    expect(CODE_GEN.qualityRetainedPct).toBeGreaterThan(trueRetained - 0.1);
  });

  it('the quality spread the prose claims is the spread of the rows actually drawn', () => {
    // The bug this locks out: Figure 3 says "the quality difference across
    // this table is N points". Draw a row below the floor and that sentence
    // silently becomes false — code-gen's full frontier spans 42 points, not
    // 2.1. The claim must describe the drawn rows, not a convenient subset.
    const qualities = CODE_GEN.rows.map((r) => r.quality);
    const spread = (Math.max(...qualities) - Math.min(...qualities)) * 100;
    expect(CODE_GEN.qualityGapPoints).toBeCloseTo(spread, 1);
    for (const r of CODE_GEN.rows) expect(r.quality).toBeGreaterThanOrEqual(CODE_GEN.floor);

    const cg = baseline.frontiers.find((f) => f.frontier.cluster_id === 'code-gen')!.frontier;
    expect(CODE_GEN.belowFloor).toBe(cg.points.filter((p) => p.quality < CODE_GEN.floor).length);
    expect(CODE_GEN.rows.length + CODE_GEN.belowFloor).toBe(cg.points.length);
  });

  it('the aggregate counts follow the documented recipe', () => {
    const points = baseline.frontiers.flatMap(({ frontier: f }) => f.points);
    const models = new Set<string>();
    for (const p of points) {
      const sc = p.strategyConfig as {
        model?: string;
        models?: string[];
        stages?: Array<{ model?: string }>;
        draftModel?: string;
        verifierModel?: string;
        startModel?: string;
        upgradeModel?: string;
        decomposerModel?: string;
      };
      for (const k of ['model', 'draftModel', 'verifierModel', 'startModel', 'upgradeModel', 'decomposerModel'] as const) {
        if (sc[k]) models.add(sc[k]!);
      }
      for (const m of sc.models ?? []) models.add(m);
      for (const st of sc.stages ?? []) if (st.model) models.add(st.model);
    }
    expect(EVIDENCE.workloadTypes).toBe(baseline.frontiers.length);
    expect(EVIDENCE.measuredStrategies).toBe(points.length);
    expect(EVIDENCE.routableModels).toBe(models.size);
    expect(EVIDENCE.gradedEvaluations).toBe(
      points.reduce((sum, p) => sum + (p.evidence?.n ?? 0), 0),
    );
  });
});

/** Every file that renders visitor-facing landing copy. landing.tsx was added
 * 2026-09-04: it is the composition that carries most of the page's prose and
 * the specimen router table, and it was outside this guard entirely — the
 * largest unscanned surface on the page. */
const LANDING_FILES = [
  ['components/landing.tsx', resolve(__dirname, '../components/landing.tsx')] as const,
  ...readdirSync(resolve(__dirname, '../components/landing'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ['components/landing/' + f, resolve(__dirname, '../components/landing', f)] as const),
  ['components/site-header.tsx', resolve(__dirname, '../components/site-header.tsx')] as const,
];

describe('the withheld winner never reaches the page', () => {
  it('is absent from the generated evidence', () => {
    const generated = readFileSync(resolve(__dirname, '../lib/evidence.generated.ts'), 'utf8');
    expect(WITHHELD.test(generated)).toBe(false);
  });

  // Swept over LANDING_FILES rather than components/landing alone (extended
  // 2026-09-04). The old sweep read one directory, so landing.tsx — the
  // composition carrying the page's prose, every figure caption and the
  // specimen router table, and the file that actually renders the four
  // "name withheld" masks — was never checked. site-header.tsx was not
  // either. Both are visitor-facing; a name typed into either ships.
  //
  // Deliberately NOT comment-stripped: the retyped-measurement guard below
  // tolerates comments because dated provenance belongs there, but a withheld
  // name has no business anywhere in a file that reaches the browser.
  it.each(LANDING_FILES)('is absent from %s', (_name, path) => {
    expect(WITHHELD.test(readFileSync(path, 'utf8'))).toBe(false);
  });

  it('sweeps the whole landing surface, not one directory', () => {
    // Guards rot by narrowing. If the composition or the header ever drops
    // out of the sweep, the mask stops being checked where it is rendered.
    const swept = LANDING_FILES.map(([n]) => n);
    expect(swept).toContain('components/landing.tsx');
    expect(swept).toContain('components/site-header.tsx');
    expect(swept.filter((n) => n.startsWith('components/landing/')).length).toBeGreaterThan(5);
  });

  it('the baseline DOES contain it — so the mask is doing work, not passing vacuously', () => {
    const raw = readFileSync(resolve(REPO, 'packages/db/baseline/platform-frontiers.json'), 'utf8');
    expect(WITHHELD.test(raw)).toBe(true);
  });
});

/** Comments carry dated decision provenance ("operator, 2026-08-20") and must
 * stay; what may not come back is a measurement retyped into the markup. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}


/** Percentages and dollar amounts that are NOT measurements, and the reason
 * each is allowed to be typed. The list is the point: a number on this page
 * is either read from evidence.generated.ts or it is here, with a sentence
 * saying why it is not a measurement. A new figure fails until someone makes
 * that choice deliberately.
 *
 * Calibrated 2026-09-04 against the page as it then stood. */
const NOT_MEASUREMENTS: Record<string, Record<string, string>> = {
  'components/landing.tsx': {
    '95%': 'the confidence-interval convention ("95% intervals drawn"), not a measured value',
    // The specimen router in section 02. Its own figcaption says "numbers
    // illustrative"; they deliberately resemble real rows without being any.
    // Two of them (0.977, $0.55) do collide with live baseline values, which
    // is exactly why they need naming here rather than pattern-matching.
    '11%': 'illustrative specimen router — figcaption says "numbers illustrative"',
    '$0.05': 'illustrative specimen router row',
    '$0.55': 'illustrative specimen router row',
    '$0.01': 'illustrative specimen router row',
    '$0.12': 'illustrative specimen router row',
  },
  'components/landing/frontier-explorer.tsx': {
    '95%': 'the confidence-interval convention, drawn as an axis label',
  },
  'components/landing/receipt.tsx': {
    '0%': 'CSS clip-path geometry',
    '100%': 'CSS clip-path geometry',
  },
  'components/landing/reveal.tsx': {
    '10%': 'IntersectionObserver rootMargin',
  },
};

/** How the page would render each derived headline figure. These have a
 * generator behind them, so seeing one typed as a literal means someone
 * retyped a measurement instead of reading it — the 2026-09-04 bug exactly
 * (a card said "99%" and "$6.26" while CODE_GEN said 97.8 and 6.2568).
 *
 * CODE_GEN.floor is deliberately NOT here: 0.95 is a policy setting the page
 * states as a bar, not a measured result, and it is written in four files. */
function derivedRenderings() {
  return [
    `${CODE_GEN.qualityRetainedPct}%`,
    `${CODE_GEN.qualityGapPoints} points`,
    `$${CODE_GEN.minCost}`,
    `$${CODE_GEN.maxCost}`,
    `$${CODE_GEN.maxCost.toFixed(2)}`,
    `${CODE_GEN.ratio}×`,
    `${CODE_GEN.ratio}x`,
  ];
}

/** A dollar amount ($0.0231) or a percentage (97.8%, 49%). Interpolated
 * values are invisible to it by construction: `$${x}` has no digit after the
 * '$', and `${w}%` has no digit before the '%' — so reading a number from the
 * generated evidence is always the way to pass. */
const MONEY_OR_PERCENT = /\$\d[\d.,]*|\d+(?:\.\d+)?\s*%/g;

describe('no measurement is retyped into the markup', () => {
  const files = LANDING_FILES;

  it('no hardcoded measurement date survives outside comments', () => {
    for (const [name, path] of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code.match(/20\d\d-\d\d-\d\d/g), `${name} hardcodes a measurement date`).toBeNull();
    }
  });

  it('no hardcoded price ratio survives outside comments', () => {
    for (const [name, path] of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      // '270×' / '271x' typed as text, rather than read from CODE_GEN.ratio.
      expect(code.match(/\b2[0-9]{2}\s*[×x]\b/g), `${name} hardcodes a price ratio`).toBeNull();
    }
  });

  it('no derived headline figure is typed as a literal', () => {
    const renderings = derivedRenderings();
    for (const [name, path] of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      for (const r of renderings) {
        expect(
          code.includes(r),
          `${name} types "${r}" — that figure is derived, so read it from CODE_GEN instead`,
        ).toBe(false);
      }
    }
  });

  it('every percentage and dollar figure is either derived or a named non-measurement', () => {
    const unexplained: string[] = [];
    for (const [name, path] of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      const allowed = NOT_MEASUREMENTS[name] ?? {};
      for (const literal of new Set(code.match(MONEY_OR_PERCENT) ?? [])) {
        const key = literal.replace(/\s+%/, '%');
        if (!(key in allowed)) unexplained.push(`${name}: ${key}`);
      }
    }
    expect(
      unexplained,
      'each of these is a typed percentage or dollar amount with no stated provenance — ' +
        'read it from evidence.generated.ts, or add it to NOT_MEASUREMENTS with the reason ' +
        'it is not a measurement',
    ).toEqual([]);
  });

  it('the allow-list does not outlive the numbers it explains', () => {
    // A stale exemption is how a guard quietly stops guarding: the figure is
    // removed or made derived, the entry stays, and it silently blesses the
    // next thing that happens to render the same string.
    const stale: string[] = [];
    for (const [name, path] of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      const present = new Set(
        (code.match(MONEY_OR_PERCENT) ?? []).map((l) => l.replace(/\s+%/, '%')),
      );
      for (const literal of Object.keys(NOT_MEASUREMENTS[name] ?? {})) {
        if (!present.has(literal)) stale.push(`${name}: ${literal}`);
      }
    }
    for (const name of Object.keys(NOT_MEASUREMENTS)) {
      if (!files.some(([f]) => f === name)) stale.push(`${name}: file is no longer on the page`);
    }
    expect(stale, 'these NOT_MEASUREMENTS entries no longer match anything — delete them').toEqual([]);
  });

  it('every allow-list entry states a reason', () => {
    for (const [name, entries] of Object.entries(NOT_MEASUREMENTS)) {
      for (const [literal, why] of Object.entries(entries)) {
        expect(why.trim().length, `${name}: ${literal} has no stated reason`).toBeGreaterThan(10);
      }
    }
  });
});

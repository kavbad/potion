// Judge calibration tests (SPEC §5 → G0.2): judges calibrated against
// DETERMINISTIC ground truth (+ the original pairwise-agreement story).
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createMockProvider, loadPrices } from '@potion/providers';
import { BudgetCapError } from './estimate.js';
import {
  buildRubricProbes,
  CALIBRATION_FLAG_BELOW,
  correlationCi,
  pearson,
  projectCalibrationCostUsd,
  projectProbeCalibrationCostUsd,
  RubricProbeInsufficientError,
  runJudgeCalibration,
  runRubricProbeCalibration,
  spearman,
  truncateAtWordBoundary,
  withCalibrationJudges,
} from './calibrate.js';
import type { EvalItem } from '@potion/core';
import { loadSuite, SIMULATED_SUITES_DIR } from './suites.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

describe('pearson', () => {
  it('hand-computed on known vectors', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 1, 1], [1, 1, 1])).toBe(1); // constant-equal degenerate
    expect(pearson([1], [2])).toBe(0); // too few points
  });
});

describe('spearman', () => {
  it('rank correlation: perfect for any monotone map, ties averaged', () => {
    // compressed monotone scale: pearson < 1, spearman = 1
    const truth = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
    const compressed = [0.90, 0.92, 0.93, 0.95, 0.98, 1.0];
    expect(spearman(compressed, truth)).toBeCloseTo(1, 10);
    expect(pearson(compressed, truth)).toBeLessThan(1);
    // anti-monotone → -1; ties handled
    expect(spearman([3, 2, 1], [1, 2, 3])).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 2], [1, 1, 2])).toBeCloseTo(1, 10);
    expect(spearman([1], [2])).toBe(0);
  });
});

describe('correlationCi (G2.8) — a trust bar needs an interval, not a point', () => {
  // Fixed vectors; no randomness in the test itself.
  const truth = [0.1, 0.25, 0.3, 0.45, 0.5, 0.62, 0.7, 0.8, 0.9, 1.0];
  const goodJudge = truth.map((t, i) => Math.min(1, t + (i % 3) * 0.02));
  const noisyJudge = [0.9, 0.1, 0.5, 0.95, 0.2, 0.7, 0.15, 0.85, 0.3, 0.6];

  it('is reproducible per (data, seed) and brackets the point estimate', () => {
    const a = correlationCi(goodJudge, truth, 'pearson', 4242);
    const b = correlationCi(goodJudge, truth, 'pearson', 4242);
    expect(a).toEqual(b);
    expect(a!.estimate).toBeCloseTo(pearson(goodJudge, truth), 12);
    expect(a!.ci95[0]).toBeLessThanOrEqual(a!.estimate);
    expect(a!.ci95[1]).toBeGreaterThanOrEqual(a!.estimate);
  });

  it('resamples PAIRS — shuffling one vector alone destroys the correlation', () => {
    // If the implementation resampled the two vectors independently, the
    // pairing (which is the entire content of a correlation) would be lost
    // and a strong relationship would bootstrap to ~0.
    const strong = correlationCi(goodJudge, truth, 'pearson', 7)!;
    expect(strong.ci95[0]).toBeGreaterThan(0.5);
  });

  it('separates a trustworthy judge from a noisy one BY INTERVAL, not by point', () => {
    const good = correlationCi(goodJudge, truth, 'pearson', 11)!;
    const noisy = correlationCi(noisyJudge, truth, 'pearson', 11)!;
    // The good judge's whole interval clears the bar; the noisy judge's
    // whole interval fails it. Those are the two defensible verdicts.
    expect(good.ci95[0]).toBeGreaterThanOrEqual(CALIBRATION_FLAG_BELOW);
    expect(noisy.ci95[1]).toBeLessThan(CALIBRATION_FLAG_BELOW);
  });

  it('is ASYMMETRIC around the estimate — why a ± half-width would lie', () => {
    const r = correlationCi(goodJudge, truth, 'pearson', 3)!;
    const below = r.estimate - r.ci95[0];
    const above = r.ci95[1] - r.estimate;
    // A correlation near 1 is bounded above and skews downward.
    expect(below).toBeGreaterThan(above);
  });

  it('refuses below CORRELATION_CI_MIN_PAIRS rather than reporting a confident lie', () => {
    expect(correlationCi([1, 2, 3], [1, 2, 3], 'pearson', 1)).toBeNull();
    expect(correlationCi([1, 2, 3, 4], [1, 2, 3, 4], 'pearson', 1)).not.toBeNull();
    expect(correlationCi([1, 2], [1, 2, 3], 'pearson', 1)).toBeNull(); // length mismatch
  });

  it('spearman variant works on rank-monotone-but-scale-distorted data', () => {
    const distorted = truth.map((t) => t ** 3); // monotone, badly scaled
    const p = correlationCi(distorted, truth, 'pearson', 5)!;
    const s = correlationCi(distorted, truth, 'spearman', 5)!;
    expect(s.estimate).toBeGreaterThan(p.estimate); // ranks survive the distortion
    expect(s.ci95[0]).toBeGreaterThan(0.9);
  });
});

describe('runJudgeCalibration', () => {
  it('two judge variants agree ≥ 0.8 on 30 double-scored answers', { timeout: 60_000 }, async () => {
    // code-gen.jsonl moved to suites/simulated/ (M1a mock-corpus quarantine);
    // calibration on it is a CI simulation by design.
    const items = loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 30);
    expect(items).toHaveLength(30);
    const report = await runJudgeCalibration(items, {
      prices: loadPrices(PRICES_PATH).table,
    });
    expect(report.n).toBe(30);
    expect(report.judgeA).toBe('mock-judge-a');
    expect(report.judgeB).toBe('mock-judge-b');
    // Independent noise: the two judges' scores are NOT identical…
    const differ = report.pairs.some((p) => p.scoreA !== p.scoreB);
    expect(differ).toBe(true);
    // …but they agree strongly because both derive from ground truth.
    expect(report.pearson).toBeGreaterThanOrEqual(0.8);
    expect(report.flagged).toBe(false);
    // G0.2: judge-vs-TRUTH stats — mock judges derive from corpus truth, so
    // each correlates strongly with the deterministic score.
    expect(report.truth).toHaveLength(2);
    for (const t of report.truth) {
      expect(t.pearsonVsTruth).toBeGreaterThanOrEqual(0.8);
      expect(t.spearmanVsTruth).toBeGreaterThanOrEqual(0.6); // ranks track truth
      expect(t.flagged).toBe(false);
      expect(t.resolvedModel).toBe(`${t.judgeModel}-v1`);
      expect(t.meanAbsErr).toBeGreaterThanOrEqual(0);
    }
    expect(report.spendUsd).toBe(0); // mock — but RECORDED, not omitted
    expect(report.pairs.every((p) => typeof p.truth === 'number')).toBe(true);
    expect(report.skipped).toHaveLength(0);
  });

  it('rejects llm-judge items — no ground truth, nothing to calibrate against', async () => {
    const items = loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 2);
    const poisoned = [
      ...items,
      {
        ...items[0]!,
        id: 'no-truth-01',
        scoring: { kind: 'llm-judge' as const, rubric: 'r', judgeModel: 'mock-judge', scale: [0, 4] as [number, number] },
      },
    ];
    await expect(runJudgeCalibration(poisoned, { prices: loadPrices(PRICES_PATH).table })).rejects.toThrow(
      /DETERMINISTIC ground truth/,
    );
  });

  it('preflight-caps PRICED calibrations before any call (BudgetCapError)', async () => {
    const base = loadPrices(PRICES_PATH).table;
    // A judge priced like the real judge-class: projection > $0 cap → refuse.
    const items = loadSuite('extraction', SIMULATED_SUITES_DIR).slice(0, 5);
    const projected = projectCalibrationCostUsd(items, ['judge-class'], 'mock-cheap', base);
    expect(projected).toBeGreaterThan(0);
    await expect(
      runJudgeCalibration(items, { prices: base, judgeModels: ['judge-class'] }),
    ).rejects.toThrow(BudgetCapError);
    // With a covering cap the same call would proceed (proven by the mock
    // suite above; live judges are exercised in the capped live run).
  });

  it('G1.4: reference-free by default (strips), anchored keeps the REFERENCE block', async () => {
    const items = loadSuite('extraction', SIMULATED_SUITES_DIR).slice(0, 2);
    const prices = withCalibrationJudges(loadPrices(PRICES_PATH).table);
    const seen: string[] = [];
    const mock = createMockProvider(prices);
    const capture = {
      ...mock,
      complete: (req: Parameters<typeof mock.complete>[0]) => {
        const text = req.messages.map((m) => m.content).join('\n');
        if (text.includes('impartial judge')) seen.push(text);
        return mock.complete(req);
      },
    };
    const providers = { anthropic: capture, openai: capture, google: capture, openrouter: capture, mock: capture };
    // default: reference-FREE — extraction items HAVE object references, but
    // the judge prompt must not contain a REFERENCE block
    await runJudgeCalibration(items, { prices, providers, judgeModels: ['mock-judge-a'] });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => !t.includes('REFERENCE:'))).toBe(true);
    // anchored: the block appears (stringified object reference)
    seen.length = 0;
    await runJudgeCalibration(items, {
      prices,
      providers,
      judgeModels: ['mock-judge-a'],
      referenceAnchored: true,
    });
    expect(seen.every((t) => t.includes('REFERENCE:'))).toBe(true);
  });

  it('single-judge calibration: agreement degenerates to 0, truth stats stand alone', async () => {
    const items = loadSuite('extraction', SIMULATED_SUITES_DIR).slice(0, 10);
    const report = await runJudgeCalibration(items, {
      prices: loadPrices(PRICES_PATH).table,
      judgeModels: ['mock-judge-a'],
    });
    expect(report.judges).toEqual(['mock-judge-a']);
    expect(report.pearson).toBe(0);
    expect(report.truth).toHaveLength(1);
    expect(report.truth[0]!.pearsonVsTruth).toBeGreaterThanOrEqual(0.8);
  });

  it('withCalibrationJudges adds both variants idempotently', () => {
    const base = loadPrices(PRICES_PATH).table;
    const once = withCalibrationJudges(base);
    const twice = withCalibrationJudges(once);
    expect(once.entries).toHaveLength(base.entries.length + 2);
    expect(twice.entries).toHaveLength(once.entries.length);
    expect(once.entries.find((e) => e.alias === 'mock-judge-a')?.provider).toBe('mock');
  });
});

// ─── G1.5 rubric-probe calibration ───────────────────────────────────────────

function replayItem(id: string, reference: string): EvalItem {
  return {
    id,
    clusterId: 'agent-x',
    prompt: [{ role: 'user', content: `replay task ${id}` }],
    reference,
    scoring: { kind: 'llm-judge', rubric: 'old rubric', judgeModel: 'mock-judge-a', scale: [0, 1] },
  };
}

const REPLAY_ITEMS = [
  replayItem('r-01', 'The retry loop now backs off exponentially with a cap of five attempts total.'),
  replayItem('r-02', 'Invoice 4421 was marked pending and the customer received a summary email.'),
  replayItem('r-03', 'The duplicate charge was refunded and a credit note was issued for the account.'),
  replayItem('r-04', 'Escalated to tier two after the diagnostic script found no configuration drift.'),
];

describe('buildRubricProbes (G1.5)', () => {
  it('3 probes per referenced item, deterministic, derangement never self-maps', () => {
    const a = buildRubricProbes(REPLAY_ITEMS, 7);
    const b = buildRubricProbes(REPLAY_ITEMS, 7);
    expect(a).toEqual(b); // deterministic under seed
    expect(a).toHaveLength(12);
    for (const item of REPLAY_ITEMS) {
      const mine = a.filter((p) => p.item.id === item.id);
      expect(mine.map((p) => p.kind).sort()).toEqual(['mismatch', 'reference', 'truncated']);
      const ref = mine.find((p) => p.kind === 'reference')!;
      expect(ref.answer).toBe(item.reference);
      expect(ref.truth).toBe(1);
      const trunc = mine.find((p) => p.kind === 'truncated')!;
      expect(trunc.answer.length).toBeLessThan((item.reference as string).length);
      expect((item.reference as string).startsWith(trunc.answer)).toBe(true);
      expect(trunc.truth).toBe(0.5);
      const mis = mine.find((p) => p.kind === 'mismatch')!;
      expect(mis.answer).not.toBe(item.reference); // derangement: never own reference
      expect(REPLAY_ITEMS.some((o) => o.reference === mis.answer && o.id !== item.id)).toBe(true);
      expect(mis.truth).toBe(0);
    }
    // every seed yields a derangement
    for (let seed = 0; seed < 20; seed++) {
      for (const p of buildRubricProbes(REPLAY_ITEMS, seed)) {
        if (p.kind === 'mismatch') expect(p.answer).not.toBe(p.item.reference);
      }
    }
  });

  it('< 3 referenced items throws the typed reason; unreferenced items are excluded', () => {
    const bare: EvalItem = { ...replayItem('r-05', 'x'), reference: undefined };
    delete bare.reference;
    expect(() => buildRubricProbes([REPLAY_ITEMS[0]!, REPLAY_ITEMS[1]!, bare], 1)).toThrow(
      RubricProbeInsufficientError,
    );
    try {
      buildRubricProbes([REPLAY_ITEMS[0]!], 1);
    } catch (e) {
      expect((e as RubricProbeInsufficientError).referencedCount).toBe(1);
    }
  });

  it('truncation cuts on a word boundary', () => {
    expect(truncateAtWordBoundary('alpha beta gamma delta')).toBe('alpha beta');
    expect(truncateAtWordBoundary('nospacesatallinthisstring')).toBe('nospacesatal');
  });
});

describe('runRubricProbeCalibration (G1.5)', () => {
  const prices = withCalibrationJudges(loadPrices(PRICES_PATH).table);

  // A judge that scores by REFERENCE/ANSWER similarity — a discriminating
  // judge yields high correlation with the constructed truth by design.
  function similarityJudge() {
    const mock = createMockProvider(prices);
    return {
      ...mock,
      complete: async (req: Parameters<typeof mock.complete>[0]) => {
        const res = await mock.complete(req);
        const text = req.messages.map((m) => m.content).join('\n');
        const block = (label: string) => {
          const re = new RegExp(`${label}:\\n<<<UNTRUSTED_DATA_BEGIN>>>\\n([\\s\\S]*?)\\n<<<UNTRUSTED_DATA_END>>>`);
          return re.exec(text)?.[1] ?? '';
        };
        const ref = block('REFERENCE');
        const ans = block('ANSWER');
        const q = ans === ref ? 1 : ref.startsWith(ans) && ans.length > 0 ? ans.length / ref.length : 0;
        return { ...res, text: `SCORE: ${q.toFixed(2)}` };
      },
    };
  }

  it('discriminating judge → high r/rho, unflagged; probes judge reference-anchored', async () => {
    const judge = similarityJudge();
    const providers = { anthropic: judge, openai: judge, google: judge, openrouter: judge, mock: judge };
    const report = await runRubricProbeCalibration(REPLAY_ITEMS, 'candidate rubric text', {
      prices,
      providers,
      judgeModels: ['mock-judge-a'],
      seed: 3,
    });
    expect(report.n).toBe(12);
    expect(report.answererModel).toBe('synthetic-perturbation');
    const t = report.truth[0]!;
    expect(t.pearsonVsTruth).toBeGreaterThan(0.9);
    expect(t.spearmanVsTruth).toBeGreaterThan(0.9);
    expect(t.flagged).toBe(false);
    expect(report.pairs.every((p) => /#(reference|truncated|mismatch)$/.test(p.itemId))).toBe(true);
  });

  it('non-discriminating judge (plain mock: unknown corpus → ~constant) → flagged', async () => {
    const report = await runRubricProbeCalibration(REPLAY_ITEMS, 'candidate rubric text', {
      prices,
      judgeModels: ['mock-judge-a'],
      seed: 3,
    });
    expect(report.truth[0]!.flagged).toBe(true);
  });

  it('preflight refuses over-cap runs BEFORE any provider call', async () => {
    const probes = buildRubricProbes(REPLAY_ITEMS, 1);
    // priced judge (judge-class) with cap 0 → must throw
    const projected = projectProbeCalibrationCostUsd(probes, 'r', ['judge-class'], prices);
    expect(projected).toBeGreaterThan(0);
    await expect(
      runRubricProbeCalibration(REPLAY_ITEMS, 'r', { prices, judgeModels: ['judge-class'] }),
    ).rejects.toThrow(BudgetCapError);
  });
});

describe('G2.4: a LIVE-recorded calibration refuses mock aliases', () => {
  // Pre-fix: `--provider live` without --calibrate-answerer silently used
  // the mock-cheap default to GENERATE answers, then stamped the record
  // provider_mode='live' — mock output presented as live calibration
  // evidence.
  it('refuses the default (mock) judges and answerer under providerMode live', async () => {
    await expect(
      runJudgeCalibration(loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 2), { providerMode: 'live', prices: loadPrices(PRICES_PATH).table, budgetCapUsd: 0 }),
    ).rejects.toThrow(/resolve to the mock provider/);
  });

  it('refuses a live run whose ANSWERER is a mock alias even with live judges', async () => {
    await expect(
      runJudgeCalibration(loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 2), {
        providerMode: 'live',
        prices: loadPrices(PRICES_PATH).table,
        judgeModels: ['judge-class'],
        answererModel: 'mock-cheap',
        budgetCapUsd: 0,
      }),
    ).rejects.toThrow(/mock-cheap/);
  });

  it('mock mode is unaffected (the guard is live-only)', async () => {
    const report = await runJudgeCalibration(loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 2), { prices: loadPrices(PRICES_PATH).table, budgetCapUsd: 0 });
    expect(report.n).toBeGreaterThan(0);
  });
});

describe('G8 — a straddling interval is NOT a pass', () => {
  // FOUND BY MEASUREMENT, not review. A difficulty-widened extraction
  // calibration (or-sonnet judging or-deepseek answers, n=50) came back
  // pearson 0.896 with CI95 [0.785, 0.963]. The tooling printed "OK" and
  // stored flagged=false — because `flagged` read the POINT estimate while
  // the field's own documentation says to read the INTERVAL.
  //
  // 0.785 < 0.8 < 0.963. By the codebase's own stated rule that run answered
  // NOTHING, and a guarantee standing on it would be standing on an
  // unanswered question. The judge may well clear the bar; this run did not
  // show it.
  //
  // `flagged` gates "do not stand a guarantee on this judge", so an
  // unanswered question must not clear it — the same fail-closed rule the
  // truth-constant case already followed.
  const straddle = (lo: number, hi: number): boolean =>
    lo < CALIBRATION_FLAG_BELOW && hi >= CALIBRATION_FLAG_BELOW;

  it('recognises the measured [0.785, 0.963] interval as spanning the bar', () => {
    expect(straddle(0.785, 0.963)).toBe(true);
  });

  it('a CI wholly ABOVE the bar is a real pass', () => {
    expect(straddle(0.81, 0.95)).toBe(false);
  });

  it('a CI wholly BELOW the bar is a real fail', () => {
    expect(straddle(0.41, 0.72)).toBe(false);
  });

  it('the bar itself is unchanged — the fix is the reading, not the threshold', () => {
    // Guard against "fixing" an indeterminate verdict by lowering the bar.
    expect(CALIBRATION_FLAG_BELOW).toBe(0.8);
  });
});

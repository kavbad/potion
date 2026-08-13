// Golden dial sweeps: corpus completeness both directions, gap-code
// completeness, byte-identical replay, generator reproducibility, and the
// structural fences (geometry pure of db; felt pure of providers).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GOLDEN_DIR = fileURLToPath(new URL('../fixtures/golden', import.meta.url));
const GENERATOR = fileURLToPath(new URL('../fixtures/generate-golden.mjs', import.meta.url));

const GOLDEN_NAMES = [
  'felt-cache',
  'ladder-simple',
  'not-live',
  'three-axis-rmk',
  'tie-quality-cost',
  'tool-partition-sweep',
];

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as Record<string, unknown>;
}

describe('corpus completeness', () => {
  it('every golden file is listed and vice versa', () => {
    const disk = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    expect(disk).toEqual([...GOLDEN_NAMES].sort());
  });

  it('the R/M/K fixture pins the flip and the evidence-sourced hint', () => {
    const rmk = load('three-axis-rmk') as {
      result: { sweeps: Array<{ toleranceMs: number | null; views: Array<Record<string, unknown>> }> };
    };
    const [def, t1000, t30] = rmk.result.sweeps;
    const topOf = (s: { views: Array<Record<string, unknown>> }) => s.views[s.views.length - 1]!;
    expect(topOf(def!)['strategyHash']).toBe('gold-r');
    expect(topOf(t1000!)['strategyHash']).toBe('gold-k');
    const infeasible = topOf(t30!);
    expect(infeasible['feasible']).toBe(false);
    expect((infeasible['gap'] as { relaxHintMs: number }).relaxHintMs).toBe(900);
  });

  it('the tool partition sweep never contains a composite (unrepresentable through motion)', () => {
    const fx = load('tool-partition-sweep') as {
      result: { domain: { singleOnly: boolean }; sweeps: Array<{ views: Array<Record<string, unknown>> }> };
    };
    expect(fx.result.domain.singleOnly).toBe(true);
    for (const sweep of fx.result.sweeps) {
      for (const v of sweep.views) {
        if (v['feasible'] === true) {
          expect(v['strategyType']).toBe('single');
        } else {
          // Build finding: positions a composite would capture at serve
          // time are REFUSED (typed), never silently served — the 400
          // stays unreachable from Lab paths.
          const code = (v['gap'] as { code: string }).code;
          expect(['position-infeasible', 'serve-partition-divergence']).toContain(code);
        }
      }
    }
    // The cascade-dominating fixture must produce at least one divergence
    // refusal — the case the first walkthrough run silently missed.
    const raw = JSON.stringify(fx);
    expect(raw).toContain('"serve-partition-divergence"');
  });

  it('felt-cache fixture: second sweep all cached, exactly one client call total', () => {
    const fx = load('felt-cache') as {
      result: {
        first: { samples: Array<{ outcome: { ok: boolean; sample?: { cached: boolean } } }> };
        second: { samples: Array<{ outcome: { ok: boolean; sample?: { cached: boolean } } }> };
        totalClientCalls: number;
      };
    };
    expect(fx.result.first.samples[0]!.outcome.sample!.cached).toBe(false);
    expect(fx.result.second.samples[0]!.outcome.sample!.cached).toBe(true);
    expect(fx.result.totalClientCalls).toBe(1);
  });

  it('every DialGap code except felt-cap-reached appears in the corpus (cap is pinned in felt.test.ts)', () => {
    const produced = new Set<string>();
    for (const name of GOLDEN_NAMES) {
      const raw = JSON.stringify(load(name));
      for (const code of ['frontier-missing', 'frontier-not-live', 'no-single-points', 'position-infeasible', 'serve-partition-divergence', 'felt-cap-reached']) {
        if (raw.includes(`"${code}"`)) produced.add(code);
      }
    }
    expect([...produced].sort()).toEqual(['frontier-not-live', 'position-infeasible', 'serve-partition-divergence']);
    // frontier-missing/no-single-points/felt-cap-reached are pinned by unit
    // tests (geometry.test.ts, felt.test.ts) — recorded split, both-ways
    // covered between the two surfaces.
  });
});

describe('generator reproducibility', () => {
  it('regenerating the corpus is byte-identical to the committed fixtures', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'lab-dial-golden-'));
    try {
      execFileSync('node', [GENERATOR, out], { stdio: 'pipe' });
      for (const name of GOLDEN_NAMES) {
        const committed = readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8');
        const regenerated = readFileSync(path.join(out, `${name}.json`), 'utf8');
        expect(regenerated, `${name} drifted — regenerate in the same commit`).toBe(committed);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('structural fences', () => {
  it('geometry is pure of the db; felt is pure of providers; nothing imports serving-side packages', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const geometry = readFileSync(path.join(srcDir, 'geometry.ts'), 'utf8');
    expect(geometry).not.toMatch(/@potion\/db/);
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(path.join(srcDir, f), 'utf8');
      expect(src, `${f} must not import provider/harness/server surfaces`).not.toMatch(
        /from '@potion\/(providers|harness|workers|server)/,
      );
    }
  });
});

// Step 4 replay suite: golden-corpus playback, adversarial mutants pinned to
// named divergence codes, INERTNESS as a table-count invariant, generator
// reproducibility, and the structural no-side-effect fence.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@potion/core';
import { createDb, migrate } from '@potion/db';
import { sql } from 'drizzle-orm';
import type { HarnessSpec } from '@potion/lab-spec';
import { replayRun, type RecordedStep, type RecordedTerminal, type ReplayDivergenceCode } from './replay.js';

const GOLDEN_DIR = fileURLToPath(new URL('../fixtures/golden', import.meta.url));
const GENERATOR = fileURLToPath(new URL('../fixtures/generate-golden.mjs', import.meta.url));

interface GoldenFixture {
  name: string;
  spec: HarnessSpec;
  steps: RecordedStep[];
  terminal: RecordedTerminal;
}

function loadGolden(name: string): GoldenFixture {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as GoldenFixture;
}

const GOLDEN_NAMES = [
  'task-simple',
  'task-tools',
  'checkin-suspend-resume',
  'fuel-killed',
  'standing-legcap',
  'memory-carry',
];

describe('corpus completeness (the Step 2 pattern)', () => {
  it('every golden file on disk is in the list, and vice versa', () => {
    const disk = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(disk).toEqual([...GOLDEN_NAMES].sort());
  });
});

describe('golden playback — the definition of done', () => {
  for (const name of GOLDEN_NAMES) {
    it(`${name} replays ok, twice, byte-identically`, () => {
      const g = loadGolden(name);
      const first = replayRun(g.spec, g.steps, g.terminal);
      expect(first.ok, JSON.stringify(!first.ok ? first.divergences : [])).toBe(true);
      // assertReproducible discipline: a second playback is byte-identical.
      const second = replayRun(g.spec, g.steps, g.terminal);
      expect(canonicalJson(second)).toBe(canonicalJson(first));
    });
  }
});

describe('adversarial mutants — fails for the RIGHT divergence', () => {
  function mutate(name: string, fn: (g: GoldenFixture) => GoldenFixture): GoldenFixture {
    return fn(JSON.parse(JSON.stringify(loadGolden(name))) as GoldenFixture);
  }
  const CASES: Array<{ label: string; code: ReplayDivergenceCode; make: () => GoldenFixture }> = [
    {
      label: 'a requestPayload byte flipped',
      code: 'request-drift',
      make: () =>
        mutate('task-tools', (g) => {
          const model = g.steps.find((s) => s.kind === 'model')!;
          (model.payload.requestPayload!.messages[1] as { content: string }).content += 'X';
          return g;
        }),
    },
    {
      label: 'a step deleted from the middle',
      code: 'stream-shape',
      make: () =>
        mutate('task-tools', (g) => {
          g.steps = g.steps.filter((s) => s.seq !== 2);
          return g;
        }),
    },
    {
      label: 'terminal state edited',
      code: 'terminal-state',
      make: () =>
        mutate('task-simple', (g) => {
          g.terminal = { state: 'failed', reason: 'edited' };
          return g;
        }),
    },
    {
      label: 'record ends with pending tool calls',
      code: 'record-exhausted',
      make: () =>
        mutate('task-tools', (g) => {
          g.steps = g.steps.slice(0, 1); // model step with tool_calls, nothing after
          g.terminal = { state: 'completed', reason: null };
          return g;
        }),
    },
    {
      label: 'record continues past a derived terminal',
      code: 'record-unconsumed',
      make: () =>
        mutate('fuel-killed', (g) => {
          // Append a fabricated extra step after the fuel kill.
          const extra = JSON.parse(JSON.stringify(g.steps[0]!)) as RecordedStep;
          extra.seq = 2;
          delete (extra.payload as { memoryReads?: unknown }).memoryReads;
          g.steps.push(extra);
          return g;
        }),
    },
    {
      label: 'estCostUsd corrupted',
      code: 'payload-mismatch',
      make: () =>
        mutate('task-simple', (g) => {
          g.steps[0]!.payload.estCostUsd = 42;
          return g;
        }),
    },
  ];
  for (const c of CASES) {
    it(`${c.label} → ${c.code}`, () => {
      const g = c.make();
      const result = replayRun(g.spec, g.steps, g.terminal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.divergences.map((d) => d.code),
          JSON.stringify(result.divergences),
        ).toContain(c.code);
      }
    });
  }

  it('every divergence code is produced by at least one mutant (no dead codes)', () => {
    const produced = new Set(CASES.map((c) => c.code));
    const ALL: ReplayDivergenceCode[] = [
      'request-drift', 'stream-shape', 'terminal-state',
      'record-exhausted', 'record-unconsumed', 'payload-mismatch',
    ];
    expect(ALL.filter((c) => !produced.has(c))).toEqual([]);
  });
});

describe('INERTNESS — playback writes nothing, as a count invariant', () => {
  it('six table counts are identical before and after a full playback', async () => {
    const h = await createDb();
    await migrate(h.db);
    const TABLES = ['request_logs', 'trace_spans', 'lab_runs', 'lab_run_steps', 'lab_harness_memory', 'usage_daily'];
    const counts = async (): Promise<number[]> => {
      const out: number[] = [];
      for (const t of TABLES) {
        const r = await h.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`));
        out.push((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
      }
      return out;
    };
    const before = await counts();
    for (const name of GOLDEN_NAMES) {
      const g = loadGolden(name);
      expect(replayRun(g.spec, g.steps, g.terminal).ok).toBe(true);
    }
    expect(await counts()).toEqual(before);
    await h.close();
  }, 120_000);

  it('structural fence: replay.ts imports neither the serving client nor the db', () => {
    const src = readFileSync(fileURLToPath(new URL('./replay.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from '\.\/serving-client/);
    expect(src).not.toMatch(/from '@potion\/db'/);
  });
});

describe('generator reproducibility', () => {
  it('regenerating the corpus is byte-identical to the committed fixtures', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'golden-regen-'));
    try {
      execFileSync('node', [GENERATOR, out], { stdio: 'pipe' });
      for (const name of GOLDEN_NAMES) {
        const committed = readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8');
        const regenerated = readFileSync(path.join(out, `${name}.json`), 'utf8');
        expect(regenerated, `${name} drifted — regenerate in the same commit that changed the loop`).toBe(committed);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('Step 8 review pin — the wrap-up is optional under replay', () => {
  it('a tool-bearing completed record WITHOUT its wrap-up (runtime wrap-up failed) replays ok', () => {
    const g = JSON.parse(JSON.stringify(loadGolden('task-tools'))) as GoldenFixture;
    // Drop the final wrap-up model step, renumber nothing (it is the last
    // step), keep terminal 'completed' — exactly what the loop records when
    // the wrap-up call fails ("a failed wrap-up never blocks completion").
    g.steps.pop();
    const result = replayRun(g.spec, g.steps, g.terminal);
    expect(result.ok, JSON.stringify(!result.ok ? result.divergences : [])).toBe(true);
  });
});

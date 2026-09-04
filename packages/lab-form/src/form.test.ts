// deriveFormState + diff + degrade + budget + zoom — against the SAME
// captured fixtures the design gate reviewed (one truth for tests and
// study), plus the branches the capture cannot reach (task silhouette,
// staleness ladder, anomaly flags).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPEC_LIMITS } from '@potion/lab-spec';
import { deriveFormState } from './form-state.js';
import { diffFormState } from './diff.js';
import { DegradeController } from './degrade.js';
import { breathScale, draw, type Canvas2DLike, type DrawView } from './draw.js';
import { THEME, ZOOM, clampZoom } from './theme.js';
import type { HarnessDto, MemoryDto, RunDto } from './dto.js';

const CAPTURED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../docs/design/step-09-captured-data.json', import.meta.url)),
    'utf8',
  ),
) as {
  harnessBefore: HarnessDto;
  harnessAfter: HarnessDto;
  memory: MemoryDto;
  runSnapshots: Array<{ tMs: number; run: RunDto }>;
};

const H = CAPTURED.harnessBefore;
const M = CAPTURED.memory;
const SNAPS = CAPTURED.runSnapshots;
const FINAL = SNAPS[SNAPS.length - 1]!.run;

describe('deriveFormState — golden derivation from the design-gate capture', () => {
  const s = deriveFormState(H, M, FINAL, 500);

  it('renders the captured harness truthfully', () => {
    expect(s.membrane.missionKind).toBe('standing');
    expect(s.membrane.laminations).toBe(0); // zero rules → thin membrane, honestly
    expect(s.filaments).toHaveLength(2);
    expect(s.filaments.every((f) => f.connection === 'not-connected')).toBe(true); // the 4th posture place
    expect(s.core.facets).toBe(0); // single strategy → smooth orb
    expect(s.core.toolsNucleus).toBe(false);
    expect(s.signatureTint).toBe(THEME.huePolicyCompound); // policy type compound
    expect(s.membrane.pores.map((p) => p.trigger)).toEqual(['on-budget-fraction', 'before-external-action']);
  });

  it('telemetry: killed-budget, est fraction saturated, measured cadence, 1:1 events', () => {
    expect(s.glow.mode).toBe('killed-budget');
    expect(s.membrane.estFraction).toBe(1); // est $0.0563 over the $0.05 cap, clamped
    expect(s.membrane.estSpentUsd).toBeGreaterThan(s.membrane.fuelCapUsd);
    expect(s.glow.breathPeriodMs).toBeGreaterThan(0); // measured, not invented
    const modelSteps = FINAL.steps.filter((x) => x.kind === 'model').length;
    expect(s.stepEvents).toHaveLength(modelSteps); // exactly, never more
  });

  it('the dial move pair changes core radius and strategy (the captured edit)', () => {
    const a = deriveFormState(CAPTURED.harnessAfter, M, null, null);
    expect(a.core.radius).toBeGreaterThan(deriveFormState(H, M, null, null).core.radius);
    expect(a.core.strategy8).not.toBe(s.core.strategy8);
    expect(a.identity.hash12).not.toBe(s.identity.hash12); // content-addressed identity moved
  });

  it('task silhouette branch (review change 4): the field is DRAWN, not phantom', () => {
    const task: HarnessDto = JSON.parse(JSON.stringify(H));
    task.spec!.mission = { kind: 'task', goal: 'one thing', doneDefinition: 'done', worthPerRunUsd: 1 };
    const t = deriveFormState(task, M, null, null);
    expect(t.membrane.missionKind).toBe('task');
    const ops = countOps((ctx, view) => draw(ctx, t, view));
    expect(ops.ellipse).toBeGreaterThan(0); // bilateral silhouette drawn
    expect(ops.headMark).toBe(true); // the head end exists for tasks only
  });

  it('Step 10: the four connection states derive per filament; the RUN status wins while attached (cut-bar reachable from the run page)', () => {
    const h: HarnessDto = JSON.parse(JSON.stringify(H));
    h.superpowers = [
      { id: 'github', scopes: ['read'], status: 'connected' },
      { id: 'linear', scopes: [], status: 'expired' },
      { id: 'slack', scopes: [], status: 'revoked' },
      { id: 'email', scopes: [], status: 'not-connected' },
    ];
    const s = deriveFormState(h, M, null, null);
    expect(s.filaments.map((f) => f.connection)).toEqual([
      'connected',
      'expired',
      'revoked',
      'not-connected',
    ]);
    // Mid-run revocation: the run poll's superpower status OVERRIDES the
    // harness snapshot — the cut bar appears on the run page, not only
    // after a harness reload.
    const run = JSON.parse(JSON.stringify(FINAL)) as RunDto;
    run.superpowers = [{ id: 'github', status: 'revoked' }];
    const withRun = deriveFormState(h, M, run, 100);
    expect(withRun.filaments[0]!.connection).toBe('revoked');
    expect(withRun.filaments[1]!.connection).toBe('expired'); // no run row → harness status stands
  });

  it('Step 10: revoked draws MORE geometry than not-connected (the cut bar exists by shape)', () => {
    const mk = (status: 'not-connected' | 'revoked'): number => {
      const h: HarnessDto = JSON.parse(JSON.stringify(H));
      h.superpowers = [{ id: 'x', scopes: [], status }];
      const s = deriveFormState(h, M, null, null);
      return countOps((ctx, view) => draw(ctx, s, view)).total;
    };
    expect(mk('revoked')).toBeGreaterThan(mk('not-connected'));
  });

  it('staleness ladder (review addition 1 + settled): live → stale → disconnected; terminal = SETTLED, never aging', () => {
    const running = JSON.parse(JSON.stringify(FINAL)) as RunDto;
    running.state = 'running';
    expect(deriveFormState(H, M, running, 100).staleness).toBe('live');
    expect(deriveFormState(H, M, running, THEME.staleAfterMs + 1).staleness).toBe('stale');
    expect(deriveFormState(H, M, running, THEME.disconnectedAfterMs + 1).staleness).toBe('disconnected');
    // A TERMINAL run is settled at ANY poll age — a completed run must
    // never show 'VIEW DISCONNECTED' (review finding).
    expect(deriveFormState(H, M, FINAL, 100).staleness).toBe('settled');
    expect(deriveFormState(H, M, FINAL, THEME.disconnectedAfterMs * 100).staleness).toBe('settled');
    // No run resolved yet but a poll target attached → the clock STILL
    // applies (an accepted-but-unreachable trial reads disconnected).
    expect(deriveFormState(H, M, null, THEME.disconnectedAfterMs + 1).staleness).toBe('disconnected');
    expect(deriveFormState(H, M, null, null).staleness).toBe('static-config');
  });

  it('breathing is NEVER an invented rhythm: no measured cadence → still at any clock (review finding)', () => {
    const zeroSteps = JSON.parse(JSON.stringify(FINAL)) as RunDto;
    zeroSteps.state = 'running';
    zeroSteps.steps = [];
    const s0 = deriveFormState(H, M, zeroSteps, 100);
    expect(s0.glow.breathPeriodMs).toBeNull();
    expect(breathScale(s0, 0, 1234, 'full')).toBe(1);
    expect(breathScale(s0, 0, 98765, 'full')).toBe(1); // still at every t
    const withCadence = deriveFormState(H, M, { ...FINAL, state: 'running' } as RunDto, 100);
    expect(withCadence.glow.breathPeriodMs).toBeGreaterThan(0);
    const a = breathScale(withCadence, 0, 0, 'full');
    const b = breathScale(withCadence, 0, 400, 'full');
    expect(a).not.toBe(b); // measured cadence breathes
    expect(breathScale(withCadence, 0, 400, 'static')).toBe(1); // degrade stills it
  });
});

describe('diff — the interpolation honesty rule, mechanized', () => {
  it('identical consecutive polls emit ZERO events (stillness is information)', () => {
    const a = deriveFormState(H, M, FINAL, 100);
    const b = deriveFormState(H, M, FINAL, 1600);
    const ev = diffFormState(a, b);
    expect(ev.pulses).toHaveLength(0);
    expect(ev.retints).toHaveLength(0);
    expect(ev.anomalies).toHaveLength(0);
    expect(ev.stateChange).toBeNull();
  });

  it('a new step is exactly one pulse; est→metered is a RETINT, never a re-fire', () => {
    // Force step 3 HOLLOW in the baseline so the retint assertion is NEVER
    // vacuous (review finding: the fixture is all-metered, so a guarded
    // assertion silently skipped).
    const mid = JSON.parse(JSON.stringify({ ...FINAL, steps: FINAL.steps.slice(0, 5) })) as RunDto;
    mid.steps[2]!.costLabel = 'est.';
    mid.steps[2]!.meteredCostUsd = null;
    const a = deriveFormState(H, M, mid, 100);
    expect(a.stepEvents.find((e) => e.seq === mid.steps[2]!.seq)!.hollow).toBe(true);
    // step 6 arrives AND step 3's cost resolves est→metered
    const next = JSON.parse(JSON.stringify({ ...FINAL, steps: FINAL.steps.slice(0, 6) })) as RunDto;
    const three = next.steps[2]!;
    three.costLabel = 'metered';
    three.meteredCostUsd = 0.002;
    const b = deriveFormState(H, M, next, 100);
    const ev = diffFormState(a, b);
    expect(ev.pulses).toHaveLength(1);
    expect(ev.pulses[0]!.seq).toBe(next.steps[5]!.seq);
    expect(ev.retints).toEqual([{ seq: three.seq, meteredUsd: 0.002 }]);
  });

  it('an anomaly-flagged step yields exactly one bead event', () => {
    const base = { ...FINAL, steps: FINAL.steps.slice(0, 4) } as RunDto;
    const a = deriveFormState(H, M, base, 100);
    const next = JSON.parse(JSON.stringify({ ...FINAL, steps: FINAL.steps.slice(0, 5) })) as RunDto;
    next.steps[4]!.fallback = true;
    const ev = diffFormState(a, deriveFormState(H, M, next, 100));
    expect(ev.anomalies).toEqual([{ seq: next.steps[4]!.seq, kind: 'fallback' }]);
  });
});

// ---- draw-op budget (spec §4) against the TRUE maxima ----
interface OpCount { total: number; ellipse: number; headMark: boolean }
function countingCtx(count: OpCount): Canvas2DLike {
  const bump = () => { count.total += 1; };
  return {
    clearRect: bump, fillRect: bump,
    beginPath: () => {}, stroke: bump, fill: bump,
    arc: () => {}, moveTo: () => {}, lineTo: () => {},
    ellipse: () => { count.ellipse += 1; },
    save: () => {}, restore: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillText: () => {},
    strokeStyle: '', fillStyle: '', lineWidth: 0, globalAlpha: 1, font: '', filter: '',
  };
}
function countOps(fn: (ctx: Canvas2DLike, view: DrawView) => void, zoom = 0): OpCount {
  const count: OpCount = { total: 0, ellipse: 0, headMark: false };
  const ctx = countingCtx(count);
  const orig = ctx.fill.bind(ctx);
  // detect the task head mark: a small filled arc after the membrane pass
  let fills = 0;
  (ctx as { fill: () => void }).fill = () => { fills += 1; orig(); if (fills >= 1) count.headMark = true; };
  fn(ctx, {
    w: 1280, h: 800, zoom, tNowMs: 1000,
    livePulses: [], anomalyBeadCount: 0, degrade: 'full',
  });
  return count;
}

describe('draw-op budget at the TRUE spec maxima', () => {
  it('far ≤ opBudgetFar, mid ≤ opBudgetMid, with MAX rules/superpowers/pulses', () => {
    const max: HarnessDto = JSON.parse(JSON.stringify(H));
    max.spec!.rules = Array.from({ length: SPEC_LIMITS.MAX_RULES }, (_v, i) => `rule ${i}`);
    // 'revoked' is the COSTLIEST filament shape (severed + cut bar) — the
    // budget is enforced at the true maximum, not a friendly average.
    max.superpowers = Array.from({ length: SPEC_LIMITS.MAX_SUPERPOWERS }, (_v, i) => ({
      id: `sp${i}`, scopes: [], status: 'revoked' as const,
    }));
    max.spec!.superpowers = max.superpowers.map((s) => ({ id: s.id, scopes: [] }));
    const state = deriveFormState(max, M, FINAL, 100);
    const pulses = state.stepEvents.map((e, i) => ({
      event: e, bornMs: 500, metered: false, angle: i,
    }));
    for (const [zoom, budget] of [[0, THEME.opBudgetFar], [0.6, THEME.opBudgetMid]] as const) {
      const count: OpCount = { total: 0, ellipse: 0, headMark: false };
      draw(countingCtx(count), state, {
        w: 1280, h: 800, zoom, tNowMs: 1000,
        livePulses: pulses, anomalyBeadCount: 3, degrade: 'full',
      });
      expect(count.total, `zoom ${zoom}: ${count.total} ops > budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });
});

describe('zoom clamp + degrade (spec §4/§5)', () => {
  it('zoom clamps to [0, MAX] and MID is the terminal depth (Step 16 guard)', () => {
    expect(clampZoom(-1)).toBe(0);
    expect(clampZoom(2)).toBe(ZOOM.MAX);
    expect(ZOOM.MAX).toBe(1); // no depth beyond mid exists to clamp INTO
  });

  it('degrade ratchets full → reduced-30 → static on sustained low fps; reduced-motion starts static', () => {
    const d = new DegradeController(false);
    expect(d.mode).toBe('full');
    d.sample(30, 0);
    expect(d.sample(30, THEME.degradeSustainMs)).toBe(true);
    expect(d.mode).toBe('reduced-30');
    d.sample(10, 3000);
    expect(d.sample(10, 3000 + THEME.degradeSustainMs)).toBe(true);
    expect(d.mode).toBe('static');
    expect(new DegradeController(true).mode).toBe('static');
  });

  it('a healthy fps burst resets the sustain window (no flappy degrade)', () => {
    const d = new DegradeController(false);
    d.sample(30, 0);
    d.sample(60, 1000); // recovered before the window closed
    expect(d.sample(30, 1500)).toBe(false);
    expect(d.mode).toBe('full');
  });
});

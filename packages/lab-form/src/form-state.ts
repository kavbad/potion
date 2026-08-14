// deriveFormState — the ONE derivation from real data to visual state
// (spec §3). Pure: no fetch, no db, no clock reads. Every field of the
// CLOSED FormState type has exactly one row in AUDIT (audit.ts); the draw
// layer consumes FormState and nothing else (the import fence). A pixel
// that wants new data must come through here and therefore through the
// audit.
import type { HarnessSpec } from '@potion/lab-spec';
import type { HarnessDto, MemoryDto, RunDto } from './dto.js';
import { signatureTint } from './theme.js';
import { THEME } from './theme.js';

type CheckInTrigger = NonNullable<HarnessSpec['checkIns']>[number]['trigger'];

export interface StepEvent {
  seq: number;
  atMs: number;
  slot: 'brain' | 'tools' | null;
  estUsd: number;
  meteredUsd: number | null;
  /** true while the cost is still the labeled estimate (hollow center). */
  hollow: boolean;
  anomaly: 'fallback' | 'latency' | null;
}

export interface FormState {
  identity: {
    name: string;
    hash12: string;
    clusterId: string;
    goal: string;
  };
  /** Review change 1: the policy hue, propagated as the organism's tint. */
  signatureTint: string;
  core: {
    /** Dial quality position normalized over the feasible ladder → [0.34, 0.64]. */
    radius: number;
    policyType: string;
    /** 0 = smooth orb (single strategy); N = stages of a compound/cascade. */
    facets: number;
    qualityFloor: number;
    p95Ms: number | null;
    strategy8: string;
    inclusionKeys: string[];
    memoryEnabled: boolean;
    toolsNucleus: boolean;
  };
  membrane: {
    /** Review change 4: the silhouette IS drawn — task is bilateral with a
     * head end, standing is radial. No phantom parameters. */
    missionKind: 'task' | 'standing';
    laminations: number;
    fuelCapUsd: number;
    hardStop: boolean;
    /** LABELED est fraction — the depleting arc. */
    estFraction: number;
    estSpentUsd: number;
    /** Metered truth — separate, never blended. */
    meteredUsd: number;
    meteredNotches: Array<{ frac: number; usd: number }>;
    /** Trigger union comes from the SPEC's own CheckIn schema (incl. 'cron'
     * — schedule-shaped check-ins render as a pore at the membrane crown). */
    pores: Array<{ trigger: CheckInTrigger; fraction: number | null }>;
  };
  filaments: Array<{
    id: string;
    scopes: number;
    /** Step 10: the four typed connection states, each with its own SHAPE
     * (severance/healing is structural, never a dimming):
     *   not-connected — severed: gap ring + thicker dead segment (Step 9)
     *   connected     — HEALED: continuous, signature-tinted, pulses cross
     *   expired       — structure intact, current broken: hollow ring, dim
     *   revoked       — severed again PLUS a cut bar at the root
     * When a run is attached, the RUN DTO's status wins (mid-run
     * revocation reaches the run page through the ordinary poll). */
    connection: 'not-connected' | 'connected' | 'expired' | 'revoked';
  }>;
  glow: {
    mode: RunDto['state'] | 'idle';
    reason: string | null;
    pendingQuestion: string | null;
    /** MEASURED mean inter-step interval; null = no cadence yet (still). */
    breathPeriodMs: number | null;
    simulated: boolean;
  };
  /** Review addition 1: typed staleness so stillness is never ambiguous.
   * 'static-config' = nothing attached (config view; poll age not
   * applicable). 'settled' = the attached run is TERMINAL — its data is
   * final, the view is alive, and no staleness clock applies (review
   * finding: a completed run must never age into 'disconnected').
   * Thresholds are THEME constants. */
  staleness: 'live' | 'stale' | 'disconnected' | 'settled' | 'static-config';
  /** The measured event stream (one per model step ARRIVED — diff.ts turns
   * consecutive derivations into emissions; nothing here is invented). */
  stepEvents: StepEvent[];
}

export function deriveFormState(
  harness: HarnessDto,
  memory: MemoryDto,
  run: RunDto | null,
  /** ms since the last successful poll; null when no run is attached. */
  pollAgeMs: number | null,
): FormState {
  const spec = harness.spec;
  if (spec === null) throw new Error('deriveFormState: harness spec no longer parses');

  const views = harness.dial.brain.views ?? [];
  const feasible = views.filter((v) => v.feasible && v.quality !== undefined);
  const qs = feasible.map((v) => v.quality!);
  const qMin = qs.length ? Math.min(...qs) : 0;
  const qMax = qs.length ? Math.max(...qs) : 1;
  const basis = harness.sidecar.choices.find((c) => c.slot === 'brain.policy')?.basis;
  const current =
    feasible.find((v) => v.strategyHash === basis?.strategyHash) ?? feasible[0];
  const qNorm =
    current && qMax > qMin ? (current.quality! - qMin) / (qMax - qMin) : 0.5;

  const steps = run?.steps ?? [];
  const modelSteps = steps.filter((s) => s.kind === 'model');
  const atMs = (iso: string): number => new Date(iso).getTime();
  const gaps: number[] = [];
  for (let i = 1; i < steps.length; i++) {
    gaps.push(atMs(steps[i]!.at) - atMs(steps[i - 1]!.at));
  }
  const breathPeriodMs = gaps.length
    ? gaps.reduce((a, b) => a + b, 0) / gaps.length
    : null;

  const cap = spec.fuel.maxUsdPerRun;
  let estAcc = 0;
  const stepEvents: StepEvent[] = [];
  const meteredNotches: Array<{ frac: number; usd: number }> = [];
  for (const s of modelSteps) {
    estAcc += s.estCostUsd ?? 0;
    const metered =
      s.costLabel === 'metered' && typeof s.meteredCostUsd === 'number'
        ? s.meteredCostUsd
        : null;
    if (metered !== null) {
      meteredNotches.push({ frac: Math.min(1, estAcc / cap), usd: metered });
    }
    stepEvents.push({
      seq: s.seq,
      atMs: atMs(s.at),
      slot: s.slot,
      estUsd: s.estCostUsd ?? 0,
      meteredUsd: metered,
      hollow: metered === null,
      anomaly: s.fallback === true ? 'fallback' : s.latencyViolated === true ? 'latency' : null,
    });
  }

  // Staleness (review findings): the clock applies whenever a poll target
  // is ATTACHED (pollAgeMs non-null) — even before the first successful
  // poll resolves a run (an accepted trial that never polls must read as
  // disconnected, not as a calm config view). A TERMINAL run is 'settled':
  // final data, live view, no clock.
  const TERMINAL_STATES = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);
  const staleness: FormState['staleness'] =
    run !== null && TERMINAL_STATES.has(run.state)
      ? 'settled'
      : pollAgeMs === null
        ? 'static-config'
        : pollAgeMs > THEME.disconnectedAfterMs
          ? 'disconnected'
          : pollAgeMs > THEME.staleAfterMs
            ? 'stale'
            : 'live';

  return {
    identity: {
      name: harness.name,
      hash12: harness.harnessHash.slice(0, 12),
      clusterId: harness.clusterId,
      goal: spec.mission.goal,
    },
    signatureTint: signatureTint(spec.brain.policy.type),
    core: {
      radius: 0.34 + 0.3 * qNorm,
      policyType: spec.brain.policy.type,
      // 0 = smooth orb (single); 1 = ONE seam marking a multi-stage
      // strategy. The DTO carries no stage count, so the form asserts
      // none (review finding: a fabricated "2" was decoration).
      facets:
        current?.strategyType === undefined || current.strategyType === 'single'
          ? 0
          : 1,
      qualityFloor: (spec.brain.policy as { qualityFloor?: number }).qualityFloor ?? 0,
      p95Ms: (spec.brain.policy as { p95Ms?: number }).p95Ms ?? null,
      strategy8: (current?.strategyHash ?? '').slice(0, 8),
      inclusionKeys: memory.entries.map((e) => e.key),
      memoryEnabled: spec.memory.enabled,
      toolsNucleus: spec.brain.toolPolicy !== undefined,
    },
    membrane: {
      missionKind: spec.mission.kind,
      laminations: spec.rules.length,
      fuelCapUsd: cap,
      hardStop: spec.fuel.hardStop,
      estFraction: Math.min(1, estAcc / cap),
      estSpentUsd: estAcc,
      meteredUsd: run?.cost.meteredUsd ?? 0,
      meteredNotches,
      pores: spec.checkIns.map((c) => ({
        trigger: c.trigger,
        fraction: 'fraction' in c ? c.fraction : null,
      })),
    },
    filaments: harness.superpowers.map((s) => ({
      id: s.id,
      scopes: s.scopes.length,
      connection: run?.superpowers.find((r) => r.id === s.id)?.status ?? s.status,
    })),
    glow: {
      mode: run?.state ?? 'idle',
      reason: run?.stateReason ?? null,
      pendingQuestion: run?.pendingQuestion ?? null,
      breathPeriodMs,
      simulated: modelSteps.some((s) => s.simulated === true),
    },
    staleness,
    stepEvents,
  };
}

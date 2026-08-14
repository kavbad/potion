// THE PIXEL-TO-PARAMETER AUDIT (spec §3, review addition 3: this check
// runs in CI via the unfiltered verify — the gate that fails unmapped
// decoration is a suite failure, not a review courtesy).
//
// Every FormState leaf has exactly one row here; every row's `source` is a
// TYPED accessor over the DTOs (a source that stops existing is a compile
// error); the draw layer is import-fenced to FormState + theme. The
// completeness meta-test (audit.test.ts) flattens a derived FormState and
// diffs both directions against these keys.
import type { HarnessDto, MemoryDto, RunDto } from './dto.js';
import type { ThemeKey } from './theme.js';

export type Cadence = 'on-load' | 'on-edit' | 'poll' | 'poll-diff' | 'on-terminal' | 'client-clock';
export type Interpolation = 'continuous-ease' | 'discrete-event' | 'static';

export interface AuditRow {
  /** The named real parameter this visual property renders. */
  parameter: string;
  /** Typed accessor to the raw datum — compile-checked against the DTOs. */
  source: (h: HarnessDto, m: MemoryDto, r: RunDto | null, pollAgeMs: number | null) => unknown;
  sourcePath: string;
  cadence: Cadence;
  interpolation: Interpolation;
}

/**
 * Keys are FormState LEAF PATHS under the flatten rule (audit.test.ts):
 * primitives are leaves; arrays are single leaves at the array path.
 */
export const AUDIT: Record<string, AuditRow> = {
  'identity.name': {
    parameter: 'harness name',
    source: (h) => h.name,
    sourcePath: 'GET /api/lab/harnesses/:hash · name',
    cadence: 'on-load', interpolation: 'static',
  },
  'identity.hash12': {
    parameter: 'content-addressed spec identity',
    source: (h) => h.harnessHash,
    sourcePath: 'harnessHash (changes on ANY spec edit)',
    cadence: 'on-edit', interpolation: 'static',
  },
  'identity.clusterId': {
    parameter: 'assigned taxonomy cluster',
    source: (h) => h.clusterId,
    sourcePath: 'harness clusterId',
    cadence: 'on-load', interpolation: 'static',
  },
  'identity.goal': {
    parameter: 'mission goal',
    source: (h) => h.spec?.mission.goal,
    sourcePath: 'spec.mission.goal',
    cadence: 'on-edit', interpolation: 'static',
  },
  signatureTint: {
    parameter: 'brain policy type → the organism tint (review change 1)',
    source: (h) => h.spec?.brain.policy.type,
    sourcePath: 'spec.brain.policy.type',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'core.radius': {
    parameter: 'dial quality position, normalized over the feasible ladder',
    source: (h) => h.dial.brain.views?.filter((v) => v.feasible).map((v) => v.quality),
    sourcePath: 'dial.brain.views[].quality + sidecar basis.strategyHash',
    cadence: 'on-edit', interpolation: 'continuous-ease',
  },
  'core.policyType': {
    parameter: 'brain policy type',
    source: (h) => h.spec?.brain.policy.type,
    sourcePath: 'spec.brain.policy.type',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'core.facets': {
    parameter: 'serving strategy shape (single = smooth; stages = facets)',
    source: (h) => h.dial.brain.views?.map((v) => v.strategyType),
    sourcePath: 'dial view strategyType at the current position',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'core.qualityFloor': {
    parameter: 'policy quality floor',
    source: (h) => (h.spec?.brain.policy as { qualityFloor?: number }).qualityFloor,
    sourcePath: 'spec.brain.policy.qualityFloor',
    cadence: 'on-edit', interpolation: 'static',
  },
  'core.p95Ms': {
    parameter: 'policy latency bound',
    source: (h) => (h.spec?.brain.policy as { p95Ms?: number }).p95Ms,
    sourcePath: 'spec.brain.policy.p95Ms',
    cadence: 'on-edit', interpolation: 'static',
  },
  'core.strategy8': {
    parameter: 'current serving strategy (8-char hash, trace-agreeing)',
    source: (h) => h.sidecar.choices.find((c) => c.slot === 'brain.policy')?.basis.strategyHash,
    sourcePath: 'sidecar choice basis.strategyHash ↔ dial view',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'core.inclusionKeys': {
    parameter: 'memory entries',
    source: (_h, m) => m.entries.map((e) => e.key),
    sourcePath: 'GET /api/lab/memory/:hash · entries[]',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'core.memoryEnabled': {
    parameter: 'memory enabled',
    source: (h) => h.spec?.memory.enabled,
    sourcePath: 'spec.memory.enabled',
    cadence: 'on-edit', interpolation: 'static',
  },
  'core.toolsNucleus': {
    parameter: 'tools slot present (second nucleus)',
    source: (h) => h.spec?.brain.toolPolicy !== undefined,
    sourcePath: 'spec.brain.toolPolicy',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'membrane.missionKind': {
    parameter: 'mission kind → silhouette (review change 4: DRAWN, task = bilateral head, standing = radial)',
    source: (h) => h.spec?.mission.kind,
    sourcePath: 'spec.mission.kind',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'membrane.laminations': {
    parameter: 'rules count (aggregated above the legibility cap; thickness stays count-driven)',
    source: (h) => h.spec?.rules.length,
    sourcePath: 'spec.rules.length',
    cadence: 'on-edit', interpolation: 'discrete-event',
  },
  'membrane.fuelCapUsd': {
    parameter: 'fuel cap',
    source: (h) => h.spec?.fuel.maxUsdPerRun,
    sourcePath: 'spec.fuel.maxUsdPerRun',
    cadence: 'on-edit', interpolation: 'static',
  },
  'membrane.hardStop': {
    parameter: 'hard stop (terminal cap on the arc)',
    source: (h) => h.spec?.fuel.hardStop,
    sourcePath: 'spec.fuel.hardStop',
    cadence: 'on-edit', interpolation: 'static',
  },
  'membrane.estFraction': {
    parameter: 'LABELED est spend fraction (the depleting arc; never blended with metered)',
    source: (_h, _m, r) => r?.steps.map((s) => s.estCostUsd),
    sourcePath: 'run steps Σ estCostUsd / fuel cap',
    cadence: 'poll', interpolation: 'continuous-ease',
  },
  'membrane.estSpentUsd': {
    parameter: 'LABELED est spend total',
    source: (_h, _m, r) => r?.steps.map((s) => s.estCostUsd),
    sourcePath: 'run steps Σ estCostUsd',
    cadence: 'poll', interpolation: 'continuous-ease',
  },
  'membrane.meteredUsd': {
    parameter: 'metered truth total (separate number, separate pixels)',
    source: (_h, _m, r) => r?.cost.meteredUsd,
    sourcePath: 'run cost.meteredUsd (request_logs join)',
    cadence: 'poll', interpolation: 'continuous-ease',
  },
  'membrane.meteredNotches': {
    parameter: 'per-step metered costs (discrete notches on the arc)',
    source: (_h, _m, r) => r?.steps.map((s) => s.meteredCostUsd),
    sourcePath: 'run steps[].meteredCostUsd where costLabel=metered',
    cadence: 'poll-diff', interpolation: 'discrete-event',
  },
  'membrane.pores': {
    parameter: 'check-ins (budget pore AT its fraction; external gate at the filament junction)',
    source: (h) => h.spec?.checkIns,
    sourcePath: 'spec.checkIns[]',
    cadence: 'on-edit', interpolation: 'static',
  },
  filaments: {
    parameter: 'declared superpowers; severed = NOT-CONNECTED (the 4th posture place, structural)',
    source: (h) => h.superpowers,
    sourcePath: 'harness superpowers[] (id, scopes, status)',
    cadence: 'on-load', interpolation: 'static',
  },
  'glow.mode': {
    parameter: 'run state (base glow)',
    source: (_h, _m, r) => r?.state,
    sourcePath: 'run state',
    cadence: 'poll', interpolation: 'discrete-event',
  },
  'glow.reason': {
    parameter: 'terminal reason (the scar detail)',
    source: (_h, _m, r) => r?.stateReason,
    sourcePath: 'run stateReason',
    cadence: 'poll', interpolation: 'static',
  },
  'glow.pendingQuestion': {
    parameter: 'the asking pore question',
    source: (_h, _m, r) => r?.pendingQuestion,
    sourcePath: 'run pendingQuestion',
    cadence: 'poll', interpolation: 'discrete-event',
  },
  'glow.breathPeriodMs': {
    parameter: 'MEASURED mean inter-step interval (never an invented rhythm)',
    source: (_h, _m, r) => r?.steps.map((s) => s.at),
    sourcePath: 'mean Δ of run steps[].at',
    cadence: 'poll', interpolation: 'continuous-ease',
  },
  'glow.simulated': {
    parameter: 'serving provenance (mock ⇒ whole-form SIMULATED treatment)',
    source: (_h, _m, r) => r?.steps.map((s) => s.simulated),
    sourcePath: 'run steps[].simulated / provenance',
    cadence: 'poll', interpolation: 'static',
  },
  staleness: {
    parameter: 'last-poll age → typed staleness (review addition 1: stillness is never ambiguous with a dead view)',
    source: (_h, _m, _r, pollAgeMs) => pollAgeMs,
    sourcePath: 'client poll clock vs last successful poll (thresholds: THEME.staleAfterMs / disconnectedAfterMs)',
    cadence: 'client-clock', interpolation: 'discrete-event',
  },
  stepEvents: {
    parameter: 'model steps ARRIVED (1:1 pulses via diff; est = hollow, metered = solid; anomaly = fringe)',
    source: (_h, _m, r) => r?.steps.filter((s) => s.kind === 'model').map((s) => s.seq),
    sourcePath: 'run steps[] diff (kind=model): at, cost, label, slot, fallback/latencyViolated',
    cadence: 'poll-diff', interpolation: 'discrete-event',
  },
};

/** Design constants: the ENUMERATED taste surface. Every THEME key must
 * appear here (audit.test.ts) so taste is inspectable and bounded. */
export const THEME_AUDIT: Record<ThemeKey, string> = {
  huePolicyMinCost: 'signature tint for min_cost (data-driven via policy type)',
  huePolicyMaxQuality: 'signature tint for max_quality',
  huePolicyCompound: 'signature tint for compound',
  tintMetered: 'RESERVED — metered truth (never policy-derived)',
  tintSevered: 'RESERVED — the severed free end',
  tintAnomalyA: 'RESERVED — anomaly fringe A',
  tintAnomalyB: 'RESERVED — anomaly fringe B',
  tintHardStop: 'RESERVED — the hard-stop terminal cap ONLY (never the failure scar)',
  tintAsking: 'RESERVED — the asking pore',
  tintAskingHalo: 'RESERVED — the asking pore halo',
  tintScar: 'RESERVED — failed/killed-operator scars (distinct from the hard-stop cap)',
  tintToolsSlot: 'RESERVED — tools-slot pulse identity (distinct from metered truth)',
  tintSimulated: 'RESERVED — the SIMULATED provenance badge',
  membraneLaminationGapPx: 'lamination spacing',
  laminationLegibilityCap: 'aggregation threshold — laminations band above this (recorded spec deviation)',
  filamentLegibilityCap: 'aggregation threshold — filaments bundle above this',
  filamentLiveWidthPx: 'live filament stroke width',
  severedDeadSegmentWidthPx: 'review change 3: severance reads by SHAPE — the dead segment is thicker geometry',
  severedGapRingRadiusPx: 'severance gap ring radius',
  severedGapPx: 'severance gap length',
  farPresenceScale: 'review change 2: far-zoom base-radius presence (presentation constant)',
  farBreathGain: 'review change 2: far-zoom breathing gain (presentation constant)',
  breathAmplitude: 'breathing amplitude at mid zoom',
  pulseAmpFloorPx: 'PROVISIONAL clamp — carries the WORTH_TO_FUEL-convention re-derivation note (review addition 2)',
  pulseAmpMaxPx: 'pulse amplitude ceiling (same provisional mapping)',
  pulseAmpUsdScale: 'pulse $-to-px scale (same provisional mapping)',
  pulseLifeMs: 'pulse render lifetime',
  easeMs: 'continuous-ease tween ceiling (interpolation honesty rule)',
  crossfadeMs: 'discrete state crossfade ceiling',
  staleAfterMs: 'staleness threshold (review addition 1)',
  disconnectedAfterMs: 'disconnected threshold (review addition 1)',
  degradeFpsReduced: 'degrade: reduced-tick threshold',
  degradeFpsStatic: 'degrade: static-form threshold',
  degradeSustainMs: 'degrade: sustain window',
  opBudgetFar: 'draw-op ceiling at far zoom (enforced by test)',
  opBudgetMid: 'draw-op ceiling at mid zoom (enforced by test)',
};

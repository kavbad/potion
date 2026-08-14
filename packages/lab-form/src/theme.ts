// THE ENUMERATED TASTE SURFACE (spec §3 constants rule): every visual
// constant the form uses lives HERE and nowhere else, and every export has
// a row in THEME_AUDIT (audit.ts) — so "is this pixel data or taste?"
// always has a checkable answer. Values were reviewed at the Step 9 design
// gate on the motion study.

export const THEME = {
  // ---- policy hues → the SIGNATURE TINT (review change 1: propagates
  // through membrane laminations, pulse strokes, and the fuel arc as the
  // organism's data-driven color; the reserved tints below never derive
  // from policy).
  huePolicyMinCost: '#d99a5b',
  huePolicyMaxQuality: '#9d7bff',
  huePolicyCompound: '#4fd1c5',

  // ---- reserved tints (NEVER policy-derived) ----
  tintMetered: '#e8f0ff', // solid pulse center / metered notch = metered truth
  tintSevered: 'rgba(70,80,99,0.53)', // the not-connected free end
  tintAnomalyA: '#ff5470', // chromatic fringe — anomalies are never smoothed away
  tintAnomalyB: '#59d2ff',
  tintHardStop: 'rgba(255,120,130,0.8)',
  tintAsking: 'rgba(140,220,255,0.95)',
  tintAskingHalo: 'rgba(140,220,255,0.35)', // the asking pore's soft ring
  tintScar: 'rgba(255,150,120,0.7)', // failed / killed-operator scars — NOT the hard-stop cap
  tintToolsSlot: 'rgba(190,210,255,0.9)', // tools-slot pulse ring — NOT metered truth
  tintSimulated: '#d9c26a', // the SIMULATED badge (house style)

  // ---- geometry ----
  membraneLaminationGapPx: 5,
  /** Aggregation rule (recorded spec deviation): laminations render
   * individually up to this cap, then band into one annulus whose
   * thickness continues to scale with the count. */
  laminationLegibilityCap: 8,
  /** Filaments render individually up to this cap, then bundle into
   * trunks with count-driven girth. */
  filamentLegibilityCap: 12,
  filamentLiveWidthPx: 2,
  /** Review change 3: severance reads by SHAPE alone at far zoom — the
   * dead segment is thicker geometry, never a color cue. */
  severedDeadSegmentWidthPx: 3.6,
  severedGapRingRadiusPx: 4.5,
  severedGapPx: 14,

  // ---- presence (review change 2: presentation constants, audited) ----
  /** Base radius multiplier at far zoom (eases to 1.0 by mid). */
  farPresenceScale: 1.22,
  /** Breathing amplitude gain at far zoom (eases to 1.0 by mid). */
  farBreathGain: 1.8,
  breathAmplitude: 0.028,

  /**
   * Pulse amplitude floor/scale (px) over per-step cost.
   *
   * RE-DERIVATION NOTE (review addition 2, the WORTH_TO_FUEL convention —
   * a PROVISIONAL labeled constant): mock per-step costs are ~$0, so v1
   * clamps amplitude into a visible band. Once LIVE per-step costs exist
   * (Step 10+ traffic), re-fit this mapping from the observed per-step
   * cost distribution and RETIRE the clamp; the observed-distribution
   * arrival is the trigger, exactly like WORTH_TO_FUEL_RATIO.
   */
  pulseAmpFloorPx: 3,
  pulseAmpMaxPx: 12,
  pulseAmpUsdScale: 1800,
  pulseLifeMs: 900,

  // ---- motion honesty ----
  /** Continuous-ease tween ceiling between measured states. */
  easeMs: 400,
  /** Discrete state crossfade ceiling. */
  crossfadeMs: 300,

  // ---- staleness (review addition 1: typed, so stillness is never
  // ambiguous between "working, nothing new" and "the view is dead").
  // Poll cadence is 1.5s; stale ≈ >2 missed polls, disconnected ≈ >6. ----
  staleAfterMs: 4000,
  disconnectedAfterMs: 10_000,

  // ---- degrade thresholds (spec §4; visible, never silent) ----
  degradeFpsReduced: 45,
  degradeFpsStatic: 20,
  degradeSustainMs: 2000,

  // ---- draw-op budget ceilings (spec §4; enforced by test) ----
  opBudgetFar: 300,
  opBudgetMid: 450,
} as const;

export type ThemeKey = keyof typeof THEME;

/** Zoom regions (spec §5). Zoom is CLAMPED at mid — schematic and the
 * file belong to Step 16; no deeper render mode exists. */
export const ZOOM = { FAR_MAX: 0.35, MID_MIN: 0.55, MAX: 1 } as const;

export function clampZoom(z: number): number {
  return Math.max(0, Math.min(ZOOM.MAX, z));
}

/** The signature tint for a policy type (review change 1). */
export function signatureTint(policyType: string): string {
  if (policyType === 'min_cost') return THEME.huePolicyMinCost;
  if (policyType === 'max_quality') return THEME.huePolicyMaxQuality;
  return THEME.huePolicyCompound;
}

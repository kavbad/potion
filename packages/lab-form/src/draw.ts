// THE DRAW LAYER — consumes FormState + THEME + the view, and NOTHING
// else. The import fence (fence.test.ts) asserts this file references no
// DTO type, no fetch, no db: a pixel that wants new data must route
// through deriveFormState and therefore through the audit.
//
// Canvas2DLike is a local STRUCTURAL interface (this package compiles
// without the DOM lib): the browser's CanvasRenderingContext2D satisfies
// it, and the budget test's op-counting stub implements it.
import type { FormState, StepEvent } from './form-state.js';
import { THEME, ZOOM } from './theme.js';

export interface Canvas2DLike {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  save(): void;
  restore(): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): {
    addColorStop(offset: number, color: string): void;
  };
  fillText(text: string, x: number, y: number): void;
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  filter: string;
}

export interface LivePulse {
  event: StepEvent;
  bornMs: number;
  /** Set by a retint event — flips the center solid without re-firing. */
  metered: boolean;
  angle: number;
}

export interface DrawView {
  w: number;
  h: number;
  /** clamped [0,1]; far < 0.35, mid ≥ 0.55 (labels/panels live in DOM). */
  zoom: number;
  /** animation clock, ms — used ONLY to phase eases and pulse ages. */
  tNowMs: number;
  livePulses: LivePulse[];
  anomalyBeadCount: number;
  degrade: 'full' | 'reduced-30' | 'static';
  simulatedPreview?: boolean;
}

export interface DrawGeometry {
  cx: number;
  cy: number;
  membraneR: number;
  coreR: number;
  fuelR: number;
  /** anchor points for the DOM label layer, keyed by anatomy part */
  anchors: Record<string, [number, number]>;
}

const ARC_A0 = Math.PI * 0.75;
const ARC_SWEEP = Math.PI * 1.5;

function arcPoint(cx: number, cy: number, r: number, frac: number): [number, number, number] {
  const a = ARC_A0 + ARC_SWEEP * frac;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a), a];
}

/** Far-zoom presence (review change 2): eases from farPresenceScale at
 * z=0 to 1.0 at z=MID_MIN — a presentation constant, audited. */
function presence(zoom: number): number {
  const t = Math.min(1, zoom / ZOOM.MID_MIN);
  return THEME.farPresenceScale + (1 - THEME.farPresenceScale) * t;
}

/**
 * The breathing scale — exported so the interpolation-honesty pin can
 * assert it directly (review finding: the first draft fell back to an
 * INVENTED 1400ms rhythm when no cadence had been measured). Breathing
 * requires ALL of: a running run, a MEASURED cadence, and full motion —
 * otherwise the form is still, and stillness is information.
 */
export function breathScale(
  state: Pick<FormState, 'glow'>,
  zoom: number,
  tNowMs: number,
  degrade: DrawView['degrade'],
): number {
  const g = state.glow;
  if (g.mode !== 'running' || degrade === 'static' || g.breathPeriodMs === null) return 1;
  const period = Math.max(700, g.breathPeriodMs * 6);
  const breathGain = THEME.farBreathGain + (1 - THEME.farBreathGain) * Math.min(1, zoom / ZOOM.MID_MIN);
  return 1 + THEME.breathAmplitude * breathGain * Math.sin((tNowMs / period) * 2 * Math.PI);
}

export function draw(ctx: Canvas2DLike, state: FormState, view: DrawView): DrawGeometry {
  const { w, h, zoom, tNowMs } = view;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2 + 8;
  const anchors: Record<string, [number, number]> = {};

  const sim = state.glow.simulated || view.simulatedPreview === true;
  const g = state.glow;
  const isTask = state.membrane.missionKind === 'task';

  // presence + breathing (MEASURED cadence only — breathScale returns 1
  // when no cadence exists, when terminal, or in static degrade)
  const pres = presence(zoom);
  const baseR = Math.min(w, h) * 0.235 * pres;
  const breath = breathScale(state, zoom, tNowMs, view.degrade);
  const dimmedByMode: Record<string, number> = {
    'killed-budget': 0.42, 'killed-operator': 0.45, failed: 0.4, idle: 0.75, pending: 0.6,
  };
  const stalenessDim = state.staleness === 'disconnected' ? 0.35 : state.staleness === 'stale' ? 0.7 : 1;
  const glowLevel =
    (g.mode === 'awaiting-human' ? 1.15 : 1) * (dimmedByMode[g.mode] ?? 1) * (sim ? 0.65 : 1) * stalenessDim;
  const tint = state.signatureTint; // review change 1: propagated

  ctx.save();
  if (sim) ctx.filter = 'saturate(0.35)';

  // field halo (tinted by the signature)
  const halo = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * 2.2);
  halo.addColorStop(0, `rgba(80,120,160,${0.1 * glowLevel})`);
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  // ---- MEMBRANE — silhouette by mission kind (review change 4) ----
  // standing = radial circle; task = bilateral ellipse with a HEAD vertex.
  const rx = isTask ? baseR * 1.18 : baseR;
  const ry = baseR;
  const lam = state.membrane.laminations;
  const drawnLams = Math.min(lam, THEME.laminationLegibilityCap);
  for (let i = 0; i <= drawnLams; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, (rx + i * THEME.membraneLaminationGapPx) * breath, (ry + i * THEME.membraneLaminationGapPx) * breath, 0, 0, Math.PI * 2);
    ctx.strokeStyle = i === 0 ? `rgba(120,140,175,${0.28 * glowLevel})` : tint;
    ctx.globalAlpha = i === 0 ? 1 : Math.max(0.06, 0.22 - i * 0.02) * glowLevel;
    ctx.lineWidth = i === 0 ? 1.4 : 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (lam > drawnLams) {
    // aggregation band (recorded deviation): thickness stays count-driven
    ctx.beginPath();
    ctx.ellipse(cx, cy, (rx + drawnLams * THEME.membraneLaminationGapPx + 4) * breath, (ry + drawnLams * THEME.membraneLaminationGapPx + 4) * breath, 0, 0, Math.PI * 2);
    ctx.strokeStyle = tint;
    ctx.globalAlpha = 0.3 * glowLevel;
    ctx.lineWidth = Math.min(14, 2 + (lam - drawnLams) * 0.12);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (isTask) {
    // the head end — direction made visible
    ctx.beginPath();
    ctx.arc(cx + rx * breath, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = tint;
    ctx.globalAlpha = 0.85 * glowLevel;
    ctx.fill();
    ctx.globalAlpha = 1;
    anchors['head'] = [cx + rx * breath, cy - 14];
  }
  anchors['membrane'] = [cx, cy + ry * breath + 4];

  // ---- FUEL ARC (tinted; est depletes; metered notches are RESERVED tint) ----
  const lamExtent = drawnLams * THEME.membraneLaminationGapPx + (lam > drawnLams ? 10 : 0);
  const fr = (Math.max(rx, ry) + lamExtent + 9) * breath;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(cx, cy, fr, ARC_A0 + ARC_SWEEP * state.membrane.estFraction, ARC_A0 + ARC_SWEEP);
  ctx.strokeStyle = tint;
  ctx.globalAlpha = 0.55 * glowLevel;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, fr, ARC_A0, ARC_A0 + ARC_SWEEP * state.membrane.estFraction);
  ctx.globalAlpha = 0.12 * glowLevel;
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const n of state.membrane.meteredNotches) {
    const [nx, ny, na] = arcPoint(cx, cy, fr, n.frac);
    ctx.beginPath();
    ctx.moveTo(nx - 5 * Math.cos(na), ny - 5 * Math.sin(na));
    ctx.lineTo(nx + 5 * Math.cos(na), ny + 5 * Math.sin(na));
    ctx.strokeStyle = THEME.tintMetered;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  if (state.membrane.hardStop) {
    const [hx, hy, ha] = arcPoint(cx, cy, fr, 1);
    ctx.beginPath();
    ctx.moveTo(hx - 7 * Math.cos(ha), hy - 7 * Math.sin(ha));
    ctx.lineTo(hx + 7 * Math.cos(ha), hy + 7 * Math.sin(ha));
    ctx.strokeStyle = THEME.tintHardStop;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  {
    const [fx, fy] = arcPoint(cx, cy, fr + 16, Math.min(0.96, Math.max(0.04, state.membrane.estFraction)));
    anchors['fuel'] = [fx, fy];
  }

  // ---- PORES ----
  for (const p of state.membrane.pores) {
    if (p.trigger === 'on-budget-fraction' && p.fraction !== null) {
      const [px, py] = arcPoint(cx, cy, fr, p.fraction);
      const asking = g.mode === 'awaiting-human';
      ctx.beginPath();
      ctx.arc(px, py, asking ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = asking ? THEME.tintAsking : `rgba(140,180,220,${0.55 * glowLevel})`;
      ctx.fill();
      if (asking && view.degrade !== 'static') {
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.strokeStyle = THEME.tintAskingHalo;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      anchors['budget-pore'] = [px, py - 18];
    }
  }

  // ---- FILAMENTS (severance reads by SHAPE — review change 3) ----
  const fil = state.filaments;
  const drawnFil = fil.slice(0, THEME.filamentLegibilityCap);
  drawnFil.forEach((f, i) => {
    const ang = Math.PI * 0.5 + (i - (drawnFil.length - 1) / 2) * (Math.PI * 0.9 / Math.max(1, drawnFil.length));
    const r0x = rx * breath, r0y = ry * breath;
    const x0 = cx + r0x * Math.cos(ang);
    const y0 = cy + r0y * Math.sin(ang);
    const len = baseR * 0.62;
    if (f.severed) {
      const cut = 0.45;
      const x1 = x0 + len * cut * Math.cos(ang);
      const y1 = y0 + len * cut * Math.sin(ang);
      // the LIVE stub — normal width
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = `rgba(150,170,205,${0.5 * glowLevel})`;
      ctx.lineWidth = THEME.filamentLiveWidthPx;
      ctx.stroke();
      // the gap ring
      ctx.beginPath();
      ctx.arc(x1 + 7 * Math.cos(ang), y1 + 7 * Math.sin(ang), THEME.severedGapRingRadiusPx, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(150,170,205,${0.55 * glowLevel})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // the DEAD segment — THICKER geometry with a blunt forked terminus,
      // legible in monochrome at far zoom (shape, not color).
      const x2 = x1 + THEME.severedGapPx * Math.cos(ang);
      const y2 = y1 + THEME.severedGapPx * Math.sin(ang);
      const x3 = x2 + len * 0.28 * Math.cos(ang);
      const y3 = y2 + len * 0.28 * Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.strokeStyle = THEME.tintSevered;
      ctx.lineWidth = THEME.severedDeadSegmentWidthPx;
      ctx.stroke();
      const perp = ang + Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(x3 - 4 * Math.cos(perp), y3 - 4 * Math.sin(perp));
      ctx.lineTo(x3 + 4 * Math.cos(perp), y3 + 4 * Math.sin(perp));
      ctx.strokeStyle = THEME.tintSevered;
      ctx.lineWidth = THEME.severedDeadSegmentWidthPx;
      ctx.stroke();
      anchors[`filament:${f.id}`] = [x3, y3 + 14];
    } else {
      const x1 = x0 + len * Math.cos(ang);
      const y1 = y0 + len * Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = tint;
      ctx.globalAlpha = 0.7 * glowLevel;
      ctx.lineWidth = THEME.filamentLiveWidthPx;
      ctx.stroke();
      ctx.globalAlpha = 1;
      anchors[`filament:${f.id}`] = [x1, y1 + 14];
    }
  });
  if (fil.length > drawnFil.length) {
    // bundle trunk (aggregation rule): girth is count-driven
    const x0 = cx, y0 = cy + ry * breath;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y0 + baseR * 0.5);
    ctx.strokeStyle = tint;
    ctx.globalAlpha = 0.5 * glowLevel;
    ctx.lineWidth = Math.min(12, 3 + (fil.length - drawnFil.length) * 0.2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    anchors['filament-bundle'] = [x0, y0 + baseR * 0.5 + 14];
  }
  if (state.membrane.pores.some((p) => p.trigger === 'before-external-action') && fil.length > 0) {
    const jx = cx, jy = cy + ry * breath;
    ctx.beginPath();
    ctx.arc(jx, jy, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(140,180,220,${0.6 * glowLevel})`;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    anchors['external-gate'] = [jx, jy + 16];
  }

  // ---- CORE ----
  const coreR = baseR * state.core.radius * breath;
  const grad = ctx.createRadialGradient(cx - coreR * 0.25, cy - coreR * 0.3, coreR * 0.1, cx, cy, coreR);
  grad.addColorStop(0, tint);
  grad.addColorStop(1, 'rgba(10,14,22,0.9)');
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.92 * glowLevel;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = `rgba(230,240,255,${0.25 * glowLevel})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (state.core.facets > 0) {
    for (let i = 0; i < state.core.facets; i++) {
      const a = (i / state.core.facets) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + coreR * Math.cos(a), cy + coreR * Math.sin(a));
      ctx.strokeStyle = `rgba(230,240,255,${0.18 * glowLevel})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  if (state.core.toolsNucleus) {
    ctx.beginPath();
    ctx.arc(cx + coreR * 0.9, cy - coreR * 0.7, coreR * 0.28, 0, Math.PI * 2);
    ctx.strokeStyle = tint;
    ctx.globalAlpha = 0.7 * glowLevel;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    anchors['tools-nucleus'] = [cx + coreR * 0.9, cy - coreR * 0.7 - 12];
  }
  state.core.inclusionKeys.forEach((_k, i) => {
    const a = i * 2.4;
    const rr = coreR * 0.5;
    ctx.beginPath();
    ctx.arc(cx + rr * Math.cos(a), cy + rr * Math.sin(a), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(235,245,255,${0.8 * glowLevel})`;
    ctx.fill();
  });
  anchors['core'] = [cx, cy - coreR - 16];

  // ---- PULSES (discrete events only — fed by diff.ts, never invented) ----
  if (view.degrade !== 'static') {
    for (const p of view.livePulses) {
      const age = (tNowMs - p.bornMs) / THEME.pulseLifeMs;
      if (age < 0 || age >= 1) continue;
      const pr = coreR + (fr - coreR) * age;
      const px = cx + pr * Math.cos(p.angle);
      const py = cy + pr * Math.sin(p.angle);
      const cost = p.metered && p.event.meteredUsd !== null ? p.event.meteredUsd : p.event.estUsd;
      const amp = Math.min(THEME.pulseAmpMaxPx, THEME.pulseAmpFloorPx + cost * THEME.pulseAmpUsdScale);
      if (p.event.anomaly !== null) {
        ctx.beginPath();
        ctx.arc(px - 1.5, py, amp, 0, Math.PI * 2);
        ctx.strokeStyle = THEME.tintAnomalyA;
        ctx.globalAlpha = 0.8 * (1 - age);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px + 1.5, py, amp, 0, Math.PI * 2);
        ctx.strokeStyle = THEME.tintAnomalyB;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(px, py, amp, 0, Math.PI * 2);
      // Slot identity gets its OWN reserved tint — tintMetered means
      // metered truth and nothing else (review finding).
      ctx.strokeStyle = p.event.slot === 'tools' ? THEME.tintToolsSlot : tint;
      ctx.globalAlpha = 0.85 * (1 - age);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (!p.event.hollow || p.metered) {
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1.5, amp * 0.4), 0, Math.PI * 2);
        ctx.fillStyle = THEME.tintMetered;
        ctx.globalAlpha = 0.9 * (1 - age);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
  // anomaly beads persist (count-driven placement)
  for (let i = 0; i < view.anomalyBeadCount; i++) {
    const [bx, by] = arcPoint(cx, cy, Math.max(rx, ry) * breath, 0.1 + i * 0.06);
    ctx.beginPath();
    ctx.arc(bx, by, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = THEME.tintAnomalyA;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ---- terminal scars + staleness/degrade marks ----
  if (g.mode === 'failed' || g.mode === 'killed-operator') {
    ctx.beginPath();
    ctx.moveTo(cx - coreR * 0.7, cy - coreR * 0.7);
    ctx.lineTo(cx + coreR * 0.7, cy + coreR * 0.7);
    // The scar tint — NOT tintHardStop: a crash is not the budget cap
    // firing (review finding: reserved tints never conflate).
    ctx.strokeStyle = THEME.tintScar;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // 'settled' and 'static-config' draw NO staleness marks — final data on
  // a live view is not a dead view (review finding).
  if (state.staleness === 'stale' || state.staleness === 'disconnected') {
    // the typed staleness mark: a broken outer ring — a dead view can
    // never impersonate a quietly working one (review addition 1)
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, fr + 12, a0, a0 + (state.staleness === 'stale' ? 0.55 : 0.28));
      ctx.strokeStyle = `rgba(160,170,190,${state.staleness === 'stale' ? 0.35 : 0.6})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(200,210,230,0.85)';
    ctx.font = '10px ui-monospace';
    ctx.fillText(state.staleness === 'stale' ? 'STALE VIEW' : 'VIEW DISCONNECTED', cx - 34, cy + fr + 28);
  }
  if (view.degrade !== 'full') {
    ctx.fillStyle = 'rgba(160,170,190,0.7)';
    ctx.font = '10px ui-monospace';
    ctx.fillText(view.degrade === 'static' ? 'reduced motion: static form' : 'reduced motion: 30fps', 12, h - 12);
  }
  ctx.restore();
  if (sim) {
    ctx.fillStyle = THEME.tintSimulated;
    ctx.font = '10px ui-monospace';
    ctx.fillText('SIMULATED', cx - 28, cy - Math.max(rx, ry) - 26);
  }

  return { cx, cy, membraneR: Math.max(rx, ry), coreR, fuelR: fr, anchors };
}

// @potion/lab-form — the derived form (Step 9): one pure derivation from
// real config + telemetry to a CLOSED visual state, a machine-checked
// pixel-to-parameter audit, an import-fenced draw layer, and the honesty
// machinery (diff-only events, typed staleness, visible degrade).
export type { HarnessDto, MemoryDto, RunDto, RunStepDto, DialViewDto } from './dto.js';
export { deriveFormState, type FormState, type StepEvent } from './form-state.js';
export { AUDIT, THEME_AUDIT, type AuditRow, type Cadence, type Interpolation } from './audit.js';
export { diffFormState, type FormEvents } from './diff.js';
export { DegradeController, type DegradeMode } from './degrade.js';
export { draw, breathScale, type Canvas2DLike, type DrawView, type DrawGeometry, type LivePulse } from './draw.js';
export { THEME, ZOOM, clampZoom, signatureTint, type ThemeKey } from './theme.js';
export { clip, narrateStep, type NarratedStep } from './narrate.js';

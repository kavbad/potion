export type { DialGap } from './gaps.js';
export {
  loadDialContext,
  SERVING_LATENCY_WINDOW_MIN,
  type DialSelectionContext,
  type LoadContextResult,
} from './context.js';
export {
  buildDialDomain,
  dialViews,
  domainFromContext,
  positionPolicy,
  viewPosition,
  DEFAULT_TOLERANCE_HEADROOM,
  type BuildDomainOptions,
  type DialDomain,
  type DialPosition,
  type DialView,
} from './geometry.js';
export { applyDialPosition, type MotionResult } from './motion.js';
export {
  DialPolicyCollisionError,
  dialPolicyId,
  dialPolicyName,
  materializeDialPolicy,
} from './materialize.js';
export {
  FELT_MIN_PROJECTION_USD,
  FELT_SWEEP_CAP_USD,
  FELT_SWEEP_MAX_POSITIONS,
  feltCacheKey,
  feltPosition,
  feltSampleCache,
  feltSweep,
  missionProbe,
  requestLogCostLookup,
  type FeltCache,
  type FeltCacheRow,
  type FeltDeps,
  type FeltOutcome,
  type FeltPositionRequest,
  type FeltSample,
  type FeltSweepResult,
  type Probe,
} from './felt.js';

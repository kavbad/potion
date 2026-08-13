/**
 * PROVISIONAL labeled constant (Step 6 review outcome 1, operator-approved).
 *
 * Rationale: "spend at most a quarter of the outcome's stated worth" — a run
 * should cost a fraction of what its result is worth, and 0.25 keeps 4×
 * headroom between value and spend.
 *
 * RE-DERIVATION PATH (recorded, binding): once Step 8 traffic exists,
 * re-derive this ratio from observed cost-per-successful-run distributions —
 * the constant is a placeholder for a measurement, and the measurement's
 * arrival is the trigger to replace it. Until then it is taste, labeled as
 * such.
 */
export const WORTH_TO_FUEL_RATIO = 0.25;

/** Fuel floor: below this a run cannot fund a single model call reliably. */
export const FUEL_MIN_USD = 0.05;

/** Fuel ceiling: matches the org live-sweep default cap scale ($5). */
export const FUEL_MAX_USD = 5;

/**
 * Hard bound on model calls per generation: one structured extraction plus
 * at most one repair pass. The generator meters like everything else; this
 * is its fuel discipline.
 */
export const GEN_MAX_MODEL_CALLS = 2;

/** p95 headroom multiplier over the chosen point's measured latency. */
export const P95_HEADROOM = 1.5;

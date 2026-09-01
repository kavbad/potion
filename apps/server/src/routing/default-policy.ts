// THE one starting rule (2026-08-28, operator: "why did it choose 74.5%
// quality... that is kind of low no?"). The answer was an incoherence: the
// first-run reveal previewed the router under max_quality with a $1.00/1K
// ceiling — a tenth of a cent per request, which prices out the entire
// mid-tier and pins weak kinds of work to weak points — while the key mint
// bound min_cost with a 0.95 quality floor. The card showed a WORSE router
// than the one the org actually got. One constant, used by both, so the
// preview and the binding can never drift again: quality-first, cheapest
// point that clears the bar.
// Canonical home is @potion/pareto's serving module (2026-08-31, one-resolver
// P0): the learning period needs the same constant and workers cannot import
// apps/server. Re-exported here so every existing import keeps working.
export { DEFAULT_ORG_POLICY } from '@potion/pareto';

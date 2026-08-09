-- 0028 — bootstrap CIs on judge-trust correlations (G2.8).
--
-- The trust gate is a HARD comparison against 0.8, but this project measured
-- the same judge at pearson 0.544 and 0.637 on two identical live n=50 runs
-- and recorded the conclusion that "single-run correlations carry ±0.1-scale
-- error". A point estimate with that much run-to-run movement, tested against
-- a fixed line, yields a verdict that flips on resampling noise.
--
-- Stored as jsonb [lo, hi] PAIRS rather than a half-width, for the same reason
-- G2.6 stores latencyP95Ci95 that way: the sampling distribution of a
-- correlation is asymmetric (it is bounded at ±1 and skews as it approaches
-- them), so a symmetric ± would assert something untrue.
--
-- `correlation_seed` makes both intervals re-derivable from the `pairs`
-- already on the row — the same audit contract every other seeded verdict in
-- this system carries.
--
-- All nullable: pre-0028 rows, corpora below CORRELATION_CI_MIN_PAIRS, and
-- constant-truth (indeterminate) calibrations legitimately have no interval.
ALTER TABLE judge_calibrations ADD COLUMN IF NOT EXISTS pearson_ci95 jsonb;
--> statement-breakpoint
ALTER TABLE judge_calibrations ADD COLUMN IF NOT EXISTS spearman_ci95 jsonb;
--> statement-breakpoint
ALTER TABLE judge_calibrations ADD COLUMN IF NOT EXISTS correlation_seed double precision;

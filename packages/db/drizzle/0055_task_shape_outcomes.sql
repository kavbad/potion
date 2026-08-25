-- Flywheel groundwork (2026-08-24), the two un-backfillable columns:
--
-- task_shape — a CONTENT-FREE structural fingerprint of the request, stamped
-- at serve time (counts, buckets, hashed tool signature; never text). The
-- join key that lets outcome statistics recur across requests and, later,
-- across tenants as k-anonymous aggregates. Cannot be reconstructed after
-- the fact because content is not retained — hence stamped now.
--
-- implicit_signals — what the SERVING PATH ITSELF observed go wrong (or
-- not) during the request: fallbacks, empty-answer retries, length cutoffs,
-- fence unwraps. THE NULL CASE IS THE POINT: an empty array means "request
-- completed and nothing was observed" — recorded silence — while NULL means
-- "row predates instrumentation". Without that distinction the honesty term
-- (what fraction of measured failures produced no implicit signal) is
-- uncomputable forever.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS task_shape jsonb;
--> statement-breakpoint
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS implicit_signals text[];

-- G1 RANDOMIZED INCUMBENT HOLDOUT (2026-09-01, the ladder's last G1 rung):
-- under EXPLICIT consent (default off), a small capped slice of eligible
-- requests serves the org's NAMED incumbent — the live baseline verified
-- savings are measured against (billing basis for pricing v2's 25%-of-
-- verified-savings), and the causal instrument outcome-driven optimization
-- requires (routing otherwise decides which requests each strategy sees).
-- Holdout rows are labeled on the ledger and never claim savings — they
-- ARE the baseline.
ALTER TABLE "org_incumbents" ADD COLUMN IF NOT EXISTS "holdout_consent" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "org_incumbents" ADD COLUMN IF NOT EXISTS "holdout_rate" double precision NOT NULL DEFAULT 0.02;
--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "holdout" boolean NOT NULL DEFAULT false;

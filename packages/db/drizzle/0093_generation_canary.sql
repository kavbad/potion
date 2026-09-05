-- 0093, G2 rung 4b (2026-09-04): CANARY — a slice of traffic serves a
-- CANDIDATE generation's frontiers instead of the promoted ones.
--
-- Rung 1 gave generations an all-or-nothing switch: promote and every
-- request moves. A canary is the same routing change applied to a fraction
-- of traffic, so the evidence for promoting it can come from the org's own
-- requests rather than from a suite. The candidate is unchanged by
-- canarying — it stays a candidate, and stopping is writing 0.
ALTER TABLE "router_generations" ADD COLUMN IF NOT EXISTS "canary_rate" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Which generation's frontiers decided THIS request. NULL for the ordinary
-- path (the promoted pins, or none at all). Set only when the canary slice
-- actually served, so the column is a record of what happened rather than
-- of what was configured — which is what rung 3 will measure over.
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "generation_id" text;

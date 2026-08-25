-- Flywheel stamps, second set (2026-08-24). Same law as 0055: content-free,
-- cheap, and impossible to backfill because content is not retained.
--
-- answer_shape — the RESPONSE's structure (length, tool calls, whether
-- requested JSON actually parsed, which stage answered): the answer-side
-- half of the honesty term. Several failure modes are visible only here.
--
-- prompt_fp — a per-org-salted one-way fingerprint of the prompt. Links
-- REPEATS within one org (sizing the caching opportunity from real data);
-- links nothing across orgs (the org id is in the hash) and reverses to
-- nothing.
--
-- session_fp — the caller's own `user` field, hashed with the org id. Links
-- requests from one end-session without identifying anyone: the raw
-- material for caller-retry and escalation modeling.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS answer_shape jsonb;
--> statement-breakpoint
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS prompt_fp text;
--> statement-breakpoint
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS session_fp text;

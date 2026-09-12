-- 2026-09-11: a proposal records the prices version it measured against,
-- beside the frontier version (0095). The 09-08 incident was a proposal
-- applied over a frontier it had never seen at prices it had never seen;
-- the apply step refuses when either is stale. NULL = pre-tracking rows.
ALTER TABLE "learning_proposals" ADD COLUMN IF NOT EXISTS "prices_version" text;

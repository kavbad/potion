-- P5 (event triggers, 2026-08-28): the mission row grows the two event
-- inlets. hook_token_hash is the sha256 of the webhook inlet's secret —
-- the plaintext is shown ONCE at arm time and never stored (the api-key
-- custody rule). feed_state carries the scheduler's per-url feed hashes
-- and rate-limit stamps ({url: {hash, checkedAt, firedAt}}), so a change
-- fires within one cycle and a hot page cannot burst checks.
-- Single statement per migration file? No — the runner prepares each file
-- whole, so both columns ride one ALTER.
ALTER TABLE "lab_missions"
  ADD COLUMN IF NOT EXISTS "hook_token_hash" text,
  ADD COLUMN IF NOT EXISTS "feed_state" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 0094 (2026-09-05): MODEL HEALTH — a catalog row remembers failing out.
--
-- Found by a live experiment. `classRepresentative` picks the CHEAPEST model
-- in a class, so every research cycle in the compiler-ladder work chose
-- `or-ling-3.0-flash` as its cheap representative — a model that could not
-- complete three of four measured arms (429 after four attempts, 60s
-- timeouts) and scored 0.583 where it did. Cheapest-in-class selects for
-- junk: a model can be cheapest precisely because it is bad.
--
-- Price was the only thing the registry knew about a model, so price was the
-- only thing selection could use. These columns are the missing half: what
-- happened LAST time we called it.
--
-- Deliberately a COUNTER and not a boolean. One 429 is weather; four in a row
-- is a model. The counter resets on any completed run, so a provider's bad
-- afternoon does not blacklist a model forever.
ALTER TABLE "models"
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_failure_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_failure_reason" text;

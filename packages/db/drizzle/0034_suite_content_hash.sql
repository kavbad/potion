-- F7: bind a certification to WHAT THE SUITE MEANS, not to a version number
-- that only moves when items are added.
--
-- Measured before this migration: rewriting every item's judge rubric left the
-- certification `certified`; purging half the items (an ordinary retention
-- cutoff) left it `certified`. The instrument changed; the vouching did not.
ALTER TABLE suite_certifications ADD COLUMN IF NOT EXISTS suite_content_hash text;
--> statement-breakpoint
COMMENT ON COLUMN suite_certifications.suite_content_hash IS
  'sha256 over the id-sorted item roster (prompt, reference, scoring) at certification time. NULL = certified before F7; treated as NOT certified, fail-closed, because such a row cannot demonstrate what it vouched for.';
--> statement-breakpoint
-- `invalidated` is a NEW terminal status, distinct from `superseded` (which
-- means a newer MEASUREMENT replaced this one). Invalidated means the
-- instrument changed underneath a still-valid measurement — nobody re-measured,
-- so the row is not history to be overwritten but a fact to be surfaced and
-- acted on. Dropping out of the partial unique index is the intended effect.
ALTER TABLE suite_certifications DROP CONSTRAINT IF EXISTS suite_certifications_status_check;
--> statement-breakpoint
ALTER TABLE suite_certifications ADD CONSTRAINT suite_certifications_status_check
  CHECK (status IN ('pending', 'certified', 'failed', 'superseded', 'invalidated'));

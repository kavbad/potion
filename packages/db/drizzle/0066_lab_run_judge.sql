-- X3 (the judge, 2026-08-28): the run's judgment — advisory measurement of
-- the deliverable against the operator's compiled rubric, stored AFTER the
-- terminal state (outside the leg record: replay determinism untouched).
-- Single statement: the migration runner prepares each file whole.
ALTER TABLE "lab_runs" ADD COLUMN IF NOT EXISTS "judge" jsonb;

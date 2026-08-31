-- X4 (2026-08-28): one trace for the family — a helper sub-run names its
-- parent, so the run page can show the tree and the fuel ledger can sum a
-- family. NULL = a root run (every pre-X4 row, unchanged).
-- Single statement: the migration runner prepares each file whole.
ALTER TABLE "lab_runs" ADD COLUMN IF NOT EXISTS "parent_run_id" text;

-- 2026-09-11: the learning period re-measures a cluster on CHANGE, not on a
-- clock. A proposal records the frontier version it measured against so the
-- next run can tell "the frontier moved" from "nothing changed". NULL on
-- rows written before this column existed (one re-measure, then tracked).
ALTER TABLE "learning_proposals" ADD COLUMN IF NOT EXISTS "frontier_version" integer;

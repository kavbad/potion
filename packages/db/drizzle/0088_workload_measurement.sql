-- G2 rung 2 (2026-09-01): PER-WORKLOAD MEASUREMENT. Discovery rows gain
-- (a) their member sample ids — the suite a workload's measurement derives
-- from IS its membership, stored at discovery so measurement never
-- re-clusters — and (b) a measurement block: the serving pick and the
-- incumbent measured on THIS workload's own items (the learning-period
-- recipe at workload grain). Eval rows land at the WORKLOAD id coordinate
-- (org-scoped), so per-workload org frontiers can aggregate them later.
-- Snapshot semantics unchanged: re-discovery replaces rows, wiping
-- measurements that described the old grouping — correctly.
ALTER TABLE "org_workloads" ADD COLUMN IF NOT EXISTS "member_trace_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "org_workloads" ADD COLUMN IF NOT EXISTS "measurement" jsonb;

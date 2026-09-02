-- 0090, G2 rung 3 (2026-09-02): WORKLOAD ADOPTION. An org may explicitly adopt a
-- MEASURED workload: serving then sub-assigns matching requests within the
-- parent cluster to the workload id, which routes on its OWN org frontier
-- (minted at adopt time from the workload's measurement rows). Never
-- silent, always reversible (retire). The sub-assignment gate is the SAME
-- threshold that formed the group at discovery — stored per row so serving
-- never re-derives it from a different config.
ALTER TABLE "org_workloads" ADD COLUMN IF NOT EXISTS "threshold" double precision NOT NULL DEFAULT 0.62;

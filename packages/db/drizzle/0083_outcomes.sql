-- G1 Outcome API (2026-09-01, review critical path): customers report what
-- ACTUALLY happened after a served response — the first ground-truth
-- evidence stream (every other quality number is a judge's opinion).
-- Routing keys (cluster/strategy/router_version) are resolved AT INGEST
-- from the served request_logs row, so outcome evidence never needs a join
-- and rows keep their attribution if logs age out. Append-only; a request
-- may accumulate several signal rows (validator now, human later) — the
-- aggregation takes the latest signal of each kind per request.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL,
  "cluster_id" text,
  "strategy_hash" text,
  "router_version" integer,
  "success" boolean,
  "score" double precision,
  "validator" text,
  "label" text,
  "human" text,
  "failure_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- X8 (2026-08-30): THE SESSION SHAPE — live steering of a running worker.
-- A steer is operator guidance queued for a RUNNING run; the loop folds
-- pending steers into the conversation at its next model step, stamps them
-- ON that step (replay re-derives the identical conversation), and marks
-- them consumed. Steering is NOT the answer channel: it can never authorize
-- an external action — only the check-in answer does that (L4).
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "lab_run_steers" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL,
  "text" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "consumed_at" timestamp with time zone,
  "consumed_seq" integer
);

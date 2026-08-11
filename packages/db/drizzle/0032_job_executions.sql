-- Potion 0032_job_executions (F10): the job-delivery dedupe ledger.
--
-- Production retries every job 3× (SPEC §12.2) and BullMQ's stalled-job
-- reaper redelivers after a worker crash regardless of the attempt limit.
-- No handler was idempotent, so a throw AFTER the spend re-ran the whole
-- handler: fresh provider money, a fresh runId, and a second pass through
-- contractual branches whose preconditions had already been mutated (the
-- advisory now resolved, the rollback now restored, the verifyAttempts
-- ledger inflated toward an early recovery-unconfirmed escalation).
--
-- WHY A LEDGER AND NOT A CONSTRAINT: two verdict rows for one tuple are
-- CORRECT when a human asked for two verifies — suite-verify's own
-- run-twice test pins that. A retry and a deliberate re-run are therefore
-- indistinguishable at the data layer; the job id is the only discriminator,
-- so dedupe has to key on the DELIVERY, not on the evidence.
--
-- Shape follows budget_events (0011), the repo's existing dedupe ledger:
-- insert ON CONFLICT DO NOTHING, and act only if you won the insert.
-- Claim-then-complete, so the three states are distinguishable:
--   claimed, completed_at NULL  -> a prior attempt died mid-flight
--   completed_at set            -> done; return the recorded result
--   absent                      -> first delivery, proceed
--
-- A claimed-but-incomplete row REFUSES on redelivery rather than re-running:
-- re-running would spend against a prior attempt whose spend we cannot
-- account for, and this platform's rule is that any doubt means no spend.
-- The refusal is durable and deliberately re-enqueueable.
CREATE TABLE IF NOT EXISTS job_executions (
  job_id text PRIMARY KEY,
  job_kind text NOT NULL,
  org_id text,
  attempt integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- The handler's return value, replayed verbatim on a redelivery of a
  -- COMPLETED job so callers see one consistent answer per logical job.
  result jsonb,
  outcome text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS job_executions_kind_idx
  ON job_executions (job_kind, claimed_at);

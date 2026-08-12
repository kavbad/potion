-- Lab Step 3 (docs/LAB-BUILD-PLAN.md): runs, per-step checkpoints, and the
-- harness memory store. Operator ruling 2026-08-11: these land in @potion/db
-- as schema-ADDITIVE core (rule 2) — no guarantee code path reads them; the
-- additive contract protects guarantee SEMANTICS, and cascade coverage is
-- proven at birth by the F5 schema-derived meta-test.
--
-- All three tables carry org_id NOT NULL REFERENCES orgs(id): org-scoped by
-- construction, erased by deleteOrgCascade, exercised by the two-org
-- isolation fixture. Harness memory is the most privacy-sensitive data the
-- Lab will hold — which is exactly why it lives HERE, inside the tenancy
-- machinery, not in Lab-private storage.
CREATE TABLE IF NOT EXISTS lab_runs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  -- The spec content hash (Step 2) — the resume identity gate: a run resumed
  -- under an edited spec is a different harness wearing the same runId.
  harness_hash text NOT NULL,
  harness_name text NOT NULL,
  -- The spec AS RUN, frozen. Replay and fork read this copy, never a file.
  spec jsonb NOT NULL,
  state text NOT NULL CHECK (state IN
    ('pending', 'running', 'awaiting-human', 'completed', 'failed',
     'killed-budget', 'killed-operator')),
  state_reason text,
  -- Last checkpointed step. Steps <= cursor_seq are never re-executed: a
  -- resumed run must not re-buy step N's tokens (F10 at the run level).
  cursor_seq integer NOT NULL DEFAULT 0,
  -- FENCING TOKEN (review addition 1): every claim bumps it, every write
  -- from an invocation is guarded `WHERE invocation_seq = mine`, so a
  -- zombie winner's late writes are rejected, not merged.
  invocation_seq integer NOT NULL DEFAULT 0,
  -- LEASE (review addition 1): a claim expires; a dead winner's claim is
  -- reclaimable after this instant, with the fence bump making it safe.
  claim_expires_at timestamptz,
  -- awaiting-human: the question asked, and the answer once recorded.
  pending_question text,
  pending_answer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lab_runs_org_state_idx ON lab_runs (org_id, state);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lab_run_steps (
  run_id text NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
  -- org_id ALSO here (denormalized): defense in depth for cross-org reads,
  -- and it puts this table under the F5 cascade meta-test in its own right.
  org_id text NOT NULL REFERENCES orgs(id),
  seq integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model', 'tool', 'check-in')),
  -- The verbatim step record (requestPayload, response, completionId,
  -- frontierTrace, usage, memory reads/writes, rngSeed, clockMs, …).
  -- Secret-scanned BEFORE write (review addition 2): a checkpoint that
  -- would contain key-shaped material is refused, fail-closed.
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lab_run_steps_org_idx ON lab_run_steps (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lab_harness_memory (
  org_id text NOT NULL REFERENCES orgs(id),
  harness_hash text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Scoped by (org, harness): readable across runs of the SAME harness,
  -- never across harnesses — enforced by key structure, not query manners.
  PRIMARY KEY (org_id, harness_hash, key)
);

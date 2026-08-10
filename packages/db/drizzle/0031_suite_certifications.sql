-- Potion 0031_suite_certifications (post-capstone item 3, Decision 2): a
-- derived suite is CERTIFIED for guarantee use only if the incumbent retains
-- its own baseline when fresh-re-evaluated against it. The capstone measured
-- the failure this gates: an incumbent scoring 0.2000 against references
-- drawn from its own sessions — every retention verdict from such a suite is
-- noise wearing a number. Certification's subject is (org, suite, suite
-- VERSION): re-derivation bumps the version and invalidates by key.
--
-- Lifecycle mirrors cluster_rubrics (0022): the partial unique index makes
-- "the active certification for a suite" a total function; supersede-don't-
-- mutate; failed and refused rows stay listed forever WITH status_reason
-- (owner rule: status + evidence, never hidden). 'pending' is reserved
-- vocabulary — today the job measures and writes certified/failed directly;
-- refusals (budget, mode-mismatch, no-incumbent, no-suite) are 'failed'
-- rows whose evidence marks refused=true: REFUSED — NOT MEASURED.
-- Owner rationale (2026-08-10, verbatim intent): an uncertified suite is one
-- the instrument declined to vouch for; letting it page a customer or roll
-- back traffic acts on evidence we won't publish.
-- Idempotent: safe to run at every boot.
CREATE TABLE IF NOT EXISTS suite_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  cluster_id text NOT NULL,
  suite_id text NOT NULL,
  suite_version text NOT NULL,
  incumbent_hash text,
  incumbent_designation_id uuid,
  provider_mode text NOT NULL DEFAULT 'mock',
  status text NOT NULL
    CHECK (status IN ('pending', 'certified', 'failed', 'superseded')),
  status_reason text,
  evidence jsonb,
  spend_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS suite_certifications_one_certified
  ON suite_certifications(suite_id) WHERE status = 'certified';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS suite_certifications_org_idx
  ON suite_certifications(org_id, created_at);

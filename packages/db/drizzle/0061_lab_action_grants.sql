-- L-G1 (Lab direction v2, 2026-08-26): the trust record. One row per
-- (org, harness, action class): the CURRENT permission state with its
-- provenance. Evidence is never stored as a scalar here — it is computed
-- from records; this table holds the standing decision and its audit
-- floor. Tightening writes are automatic; loosening writes require an
-- accepted proposal (enforced in the repo/API layer, stated here).
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "lab_action_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "harness_hash" text NOT NULL,
  "action_class" text NOT NULL,
  "risk_tier" text NOT NULL,
  "state" text NOT NULL DEFAULT 'supervised',
  "audit_rate" double precision NOT NULL DEFAULT 1,
  "state_reason" text,
  "granted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "certification_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "lab_action_grants_state_check" CHECK (state IN ('supervised','autonomous','blocked')),
  CONSTRAINT "lab_action_grants_tier_check" CHECK (risk_tier IN ('reversible-read','reversible-act','irreversible-act','never-graduates')),
  CONSTRAINT "lab_action_grants_identity" UNIQUE ("org_id","harness_hash","action_class")
);

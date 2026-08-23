-- The learning period (operator, 2026-08-22: "ask for the incumbent models
-- in onboarding" and "go" on a self-starting audit that measures the
-- customer's own quality bar).
--
-- org_incumbents: what the org uses today, and whether it agreed to Potion
-- keeping a PII-redacted sample of its requests so the bar can be measured
-- on its own prompts. No consent, no sampling, no audit.
--
-- learning_proposals: one row per (org, kind of work) measurement — the
-- incumbent's quality on the org's own prompts, the serving pick's retention
-- against it, the floor Potion proposes, the projected saving, and what it
-- cost the platform to find out. Applied by one button; never auto-applied.
CREATE TABLE IF NOT EXISTS "org_incumbents" (
  "org_id" text PRIMARY KEY REFERENCES "orgs"("id") ON DELETE CASCADE,
  "models" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "other" text,
  "sampling_consent" boolean NOT NULL DEFAULT false,
  "sample_cap_per_cluster" integer NOT NULL DEFAULT 40,
  "designated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_proposals" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "cluster_id" text NOT NULL,
  "suite_id" text NOT NULL,
  "incumbent_model" text NOT NULL,
  "incumbent_hash" text NOT NULL,
  "incumbent_quality" double precision NOT NULL,
  "incumbent_cost_per_1k" double precision,
  "serving_hash" text NOT NULL,
  "serving_model" text NOT NULL,
  "serving_quality" double precision NOT NULL,
  "serving_cost_per_1k" double precision,
  "retention" jsonb NOT NULL,
  "suggested_floor" double precision NOT NULL,
  "projected_saving" double precision,
  "items" integer NOT NULL,
  "spend_usd" double precision NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'proposed',
  "status_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz,
  "applied_policy_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_proposals_org_idx" ON "learning_proposals" ("org_id", "created_at");

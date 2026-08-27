-- O1 (Onboarding, 2026-08-27): what the org SAID it is building, interpreted
-- into a workload mix. One row per org, upserted on re-interpretation. The
-- router document carries this (and hashes it), so re-describing your
-- product mints a new router version with the change written on it.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "router_interpretations" (
  "org_id" text PRIMARY KEY NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "summary" text NOT NULL,
  "mix" jsonb NOT NULL,
  "source" text NOT NULL DEFAULT 'model' ,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

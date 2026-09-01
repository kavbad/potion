-- G1 challenger promotion proposals (2026-09-01, review loop "identify →
-- measure → prove → proposal → promote"): a shadow-QUALIFIED challenger
-- (Jeffreys lower bound ≥ floor on ≥30 live requests, cheaper on measured
-- actuals) that ALSO held retention against the serving route on the org's
-- own derived suite mints one row here. Applied by one button; never
-- auto-applied. Apply mints an ORG frontier from the same-suite
-- measurements — routing changes through the measured field under the
-- lower-bound selection law, never by fiat.
CREATE TABLE IF NOT EXISTS "challenger_proposals" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "cluster_id" text NOT NULL,
  "suite_id" text NOT NULL,
  "serving_hash" text NOT NULL,
  "serving_model" text NOT NULL,
  "serving_quality" double precision NOT NULL,
  "challenger_hash" text NOT NULL,
  "challenger_model" text NOT NULL,
  "challenger_quality" double precision NOT NULL,
  "retention" jsonb NOT NULL,
  "shadow" jsonb NOT NULL,
  "items" integer NOT NULL,
  "spend_usd" double precision NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'proposed',
  "status_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz,
  "applied_frontier_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "challenger_proposals_org_idx" ON "challenger_proposals" ("org_id", "created_at");

-- R1 (Router direction, 2026-08-27): the org's router as a MINTED artifact.
-- One row per compiled version: the full document (assignments + policy +
-- frontier provenance) and the content hash it is named by. Versions are
-- lazily minted on read — when the assembled document's hash differs from
-- the latest stored row, the next version number is appended. History is
-- append-only; nothing here is ever updated.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "router_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "router_hash" text NOT NULL,
  "document" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "router_versions_identity" UNIQUE ("org_id","version")
);

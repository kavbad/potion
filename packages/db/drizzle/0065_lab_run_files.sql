-- X1 (it computes, 2026-08-28): the per-run FILE WORKSPACE. Files a
-- worker's code produces persist across steps and legs here, become the
-- run's downloadable artifacts, and are capped both ways (the repo
-- enforces per-file and per-run totals; the sandbox enforces its own).
-- Content lives inline (bytea): artifact sizes are capped far below
-- anything that needs object storage, and one store means one custody
-- scan, one backup, one delete-with-the-org.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "lab_run_files" (
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL DEFAULT 'application/octet-stream',
  "size" integer NOT NULL,
  "sha256" text NOT NULL,
  "content" "bytea" NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "run_id", "name")
);

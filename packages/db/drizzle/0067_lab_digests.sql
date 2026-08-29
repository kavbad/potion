-- P-4 (the weekly digest, 2026-08-28): one row per org tracking the last
-- digest window sent — the dedup that makes the weekly email at-most-once
-- per window regardless of tick frequency or restarts.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "lab_digests" (
  "org_id" text PRIMARY KEY REFERENCES "orgs"("id") ON DELETE CASCADE,
  "last_window_key" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

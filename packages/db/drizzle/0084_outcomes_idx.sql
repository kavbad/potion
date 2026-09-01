-- G1 Outcome API: the evidence read is org-windowed (same shape as the
-- shadow-evidence reads). Single statement per file.
CREATE INDEX IF NOT EXISTS "outcomes_org_created_idx" ON "outcomes" ("org_id", "created_at");

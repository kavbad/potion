-- BYO-MCP (the genius door, 2026-08-28): org-registered MCP endpoints. The
-- tool surface is PINNED at registration (discovered once, custody-scanned,
-- approved by the registering admin — the provenance rule's author becomes
-- the operator) and every tool classifies fail-closed as an ACT: it gates
-- until autonomy is earned, like any external action. Bearer credentials
-- never live here — they are sealed into the grants table like every token.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "lab_custom_connectors" (
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "connector_id" text NOT NULL,
  "display_name" text NOT NULL,
  "endpoint_url" text NOT NULL,
  "server_name" text NOT NULL DEFAULT 'unknown',
  "tools" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "connector_id")
);

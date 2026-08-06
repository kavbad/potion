-- Potion 0010_alerts (M4, ROADMAP #33, SPEC §13.5): alert rules + delivery
-- audit.
--   alert_rules: one row per org notification target. kind ∈ webhook|slack;
--   events is the subscription set (quality_breach, rollback,
--   budget_warning, budget_exceeded, breaker_open). target_url may embed a
--   secret (Slack incoming-webhook path, token query param) — it lives ONLY
--   here; the delivery audit below NEVER copies it, and workers redact its
--   query string in logs/errors. disabled_at soft-disables (NULL = enabled)
--   so a rule can be silenced without losing its audit trail.
--   alert_deliveries: the delivery audit — one row per (dispatch, rule)
--   attempt-outcome. rule_id is TEXT by contract (SPEC §13.5) and
--   deliberately NOT an FK: the audit outlives the rule. status ∈
--   delivered|failed; attempts counts the tries behind the row's final
--   status (the dispatcher retries per-rule inline — see packages/workers
--   alerts:dispatch). last_error is query-string-redacted.
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  kind text NOT NULL CHECK (kind IN ('webhook', 'slack')),
  target_url text NOT NULL,
  events text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS alert_rules_org_idx ON alert_rules(org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id text NOT NULL,
  event text NOT NULL,
  status text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS alert_deliveries_rule_created_idx
  ON alert_deliveries(rule_id, created_at);

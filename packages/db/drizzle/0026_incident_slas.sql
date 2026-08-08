-- Potion 0026_incident_slas (G2.2): breach→notification latency audit.
--
-- SLA BINDING (owner standing decision, 2026-08-07, verbatim): "SLA clocks
-- start at advisory creation; notification latency is measured to the
-- contractual verdict."
--
--   alert_deliveries.incident_id    the incident the notification concerns
--     (TEXT, deliberately NOT an FK — the audit trail outlives its source,
--     the same contract as rule_id; NULL for events with no incident,
--     e.g. budget_* / breaker_open / recipe_promoted).
--   alert_deliveries.clock_start_at the SLA clock start the EMITTER binds:
--     the ADVISORY's created_at on the hierarchy path (the binding above),
--     the incident's created_at on legacy paths, the rollback's created_at
--     for restore/recovery events; NULL when the event is not SLA-bound.
--   alert_deliveries.latency_ms     now() - clock_start_at measured at the
--     SUCCESSFUL POST (clamped ≥ 0 against db/app clock skew; NULL on
--     failure — an undelivered notification has no latency — and when no
--     clock was bound).
--
-- Incidents stay 6 columns: escalation and verify-attempt state live in
-- detail jsonb (the incident row is the durable lifecycle ledger).
-- The AlertEvent vocabulary widening (guarantee_unverifiable,
-- guarantee_restored, guarantee_recovery_unconfirmed) is TS-only —
-- alert_rules.events is text[] with no CHECK.
-- Idempotent: safe to run at every boot.
ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS incident_id text;
--> statement-breakpoint
ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS clock_start_at timestamptz;
--> statement-breakpoint
ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS latency_ms double precision;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS alert_deliveries_incident_idx
  ON alert_deliveries(incident_id) WHERE incident_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS incidents_open_advisory_idx
  ON incidents(org_id, created_at) WHERE kind = 'advisory' AND resolved_at IS NULL;

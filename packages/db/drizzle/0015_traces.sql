-- Potion 0015_traces (M5, ROADMAP #36, SPEC §14.1): agent-trace ingestion +
-- retention. trace_spans stores the OTel GenAI-convention subset posted to
-- POST /v1/traces: one row per span, idempotent on (org_id, trace_id,
-- span_id) — retries and overlapping batch uploads are safe. usage/attrs are
-- jsonb: usage {input_tokens, output_tokens} feeds cost_usd (priced at
-- ingest from prices.json); attrs carries gen_ai.* payload attributes and is
-- the ONLY column redacted by retention mode '0 = metadata only' (SPEC
-- §14.3). orgs gains trace_retention_days (default 30): spans older than N
-- days are deleted by the nightly traces:purge job; 0 redacts attrs and
-- keeps metadata.
-- UNLIKE frontiers, trace spans are ORG-SCOPED: payloads may contain
-- customer data; nothing here is pooled across orgs before redaction
-- (agent-cluster synthesis redacts first — SPEC §14.2).
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS trace_spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  trace_id text NOT NULL,
  span_id text NOT NULL,
  parent_id text,
  name text NOT NULL,
  model text,
  usage jsonb NOT NULL DEFAULT '{}',
  cost_usd double precision NOT NULL DEFAULT 0,
  attrs jsonb NOT NULL DEFAULT '{}',
  ts timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trace_spans_idempotent UNIQUE (org_id, trace_id, span_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trace_spans_org_ts_idx ON trace_spans (org_id, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trace_spans_trace_idx ON trace_spans (org_id, trace_id);
--> statement-breakpoint
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS trace_retention_days integer NOT NULL DEFAULT 30;

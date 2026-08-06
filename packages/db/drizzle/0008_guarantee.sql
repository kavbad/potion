-- Potion 0008_guarantee (M3, ROADMAP #22, SPEC §12.5): quality guarantee +
-- auto-rollback evidence.
--   quality_samples: one row per SAMPLED served answer (policy.guarantee.
--   sampleRate, per-request). Written AFTER the primary response was sent
--   (fire-and-forget from the chat path; never on the latency path). The
--   quality value comes from the deterministic in-process scorer (mock
--   world) or a queued guarantee:evaluate job that scores first (live mode
--   with a queue). strategy_hash is the SERVING strategy — the rolling
--   breach evaluation groups on (org_id, strategy_hash, created_at window).
--   NOTE: no cluster column by contract (SPEC §12.5); the cluster travels
--   in incidents.detail and is derived from the serving context / the
--   current frontier's points for the periodic sweep.
--   incidents: webhook-ready guarantee incident trail. kind='rollback' —
--   the org's operating point for detail->>'clusterId' moved from
--   detail->>'fromStrategy' to detail->>'toStrategy'; the serving path
--   honors the LATEST UNRESOLVED rollback incident as the operating-point
--   override (resolving the incident restores policy routing). kind=
--   'quality_breach' — alert-only, no routing change. Cooldown (one
--   incident per (org, cluster, strategy) per window) is enforced by the
--   evaluator against detail->>'clusterId' + detail->>'fromStrategy'.
--   org_id is the tenant scope (M2 #13); rows are NEVER shared across orgs.
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS quality_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  -- Chat completion id (chatcmpl-…) — correlation label, not an FK.
  request_id text,
  strategy_hash text NOT NULL,
  quality double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quality_samples_org_strategy_created_idx
  ON quality_samples(org_id, strategy_hash, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  kind text NOT NULL CHECK (kind IN ('quality_breach', 'rollback')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by POST /api/incidents/:id/resolve; NULL while the incident is live.
  -- For kind='rollback', NULL also means the operating-point override is
  -- ACTIVE (see the header comment).
  resolved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS incidents_org_created_idx ON incidents(org_id, created_at);

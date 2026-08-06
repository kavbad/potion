-- Potion 0000_init: 12 tables (SPEC §7). Idempotent: safe to run at every boot.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS clusters (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  exemplar_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cluster_exemplars (
  id serial PRIMARY KEY,
  cluster_id text NOT NULL REFERENCES clusters(id),
  text text NOT NULL,
  embedding vector(384)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS models (
  alias text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  input_per_1m double precision NOT NULL,
  output_per_1m double precision NOT NULL,
  prices_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS strategy_configs (
  hash text PRIMARY KEY,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_items (
  id text PRIMARY KEY,
  cluster_id text NOT NULL,
  prompt jsonb NOT NULL,
  reference jsonb,
  scoring jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_runs (
  id text PRIMARY KEY,
  options jsonb NOT NULL,
  budget_cap_usd double precision NOT NULL,
  provider text NOT NULL DEFAULT 'mock',
  status text NOT NULL DEFAULT 'pending',
  spend_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_results (
  cache_key text PRIMARY KEY,
  run_id text NOT NULL,
  item_id text NOT NULL,
  cluster_id text NOT NULL,
  strategy_hash text NOT NULL,
  strategy_config jsonb NOT NULL,
  quality double precision NOT NULL,
  scorer text NOT NULL,
  judge_agreement double precision,
  usage jsonb NOT NULL,
  latency_ms jsonb NOT NULL,
  model_versions jsonb NOT NULL,
  prices_version text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS frontiers (
  id text PRIMARY KEY,
  cluster_id text NOT NULL,
  version integer NOT NULL,
  parent_id text,
  trigger text NOT NULL,
  points jsonb NOT NULL,
  prices_version text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS frontier_points (
  id serial PRIMARY KEY,
  frontier_id text NOT NULL REFERENCES frontiers(id),
  cluster_id text NOT NULL,
  strategy_hash text NOT NULL,
  strategy_config jsonb NOT NULL,
  quality double precision NOT NULL,
  cost_per_1k double precision NOT NULL,
  latency_p95 double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS policies (
  id text PRIMARY KEY,
  name text NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  policy_id text REFERENCES policies(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS request_logs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  api_key_id text,
  cluster_id text,
  strategy_hash text,
  frontier_version integer,
  policy_type text,
  model text,
  usage jsonb,
  latency_ms double precision,
  status text,
  trace text
);

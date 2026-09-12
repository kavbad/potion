-- 2026-09-11: the provider-drift tripwire — the ONE clocked measurement.
-- Weekly, every served platform point is re-asked a few fixed items with a
-- cache salt (never a hit); a reading below the stored interval is drift:
-- that model's cells are retired and the learning period re-measures.
CREATE TABLE IF NOT EXISTS "drift_canaries" (
  "id" text PRIMARY KEY,
  "week" text NOT NULL,
  "cluster_id" text NOT NULL,
  "model" text NOT NULL,
  "strategy_hash" text NOT NULL,
  "stored_quality" double precision NOT NULL,
  "stored_ci95" double precision NOT NULL,
  "observed_mean" double precision,
  "n" integer NOT NULL DEFAULT 0,
  "verdict" text NOT NULL,
  "spend_usd" double precision NOT NULL DEFAULT 0,
  "error" text,
  "cells_retired" integer NOT NULL DEFAULT 0,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);

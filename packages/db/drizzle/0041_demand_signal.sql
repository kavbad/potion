-- 0041 — THE DEMAND SIGNAL (SERVING-ROADMAP S7 / G9, leg L1).
--
-- Serving classifies every request and then discards its own evidence.
-- `pickBest` (cluster/assigner.ts) scores EVERY cluster centroid and returns
-- one id; the serve path (routes/chat.ts) keeps that id and drops the
-- confidence, the runner-up, and the margin between them. Those three
-- numbers are already bought and paid for — the embedding call that produces
-- them happens either way — and they are the only thing in the system that
-- could ever say "this request fit nothing we know".
--
-- Without them, `cluster_id` is a ROUTING LABEL and nothing more: a request
-- that matched code-gen at 0.97 and one that matched nothing and fell to
-- 'general' at 0.11 are indistinguishable after the fact. That is why nobody
-- can answer "what are customers asking for that we have never measured?"
--
-- `shape` is the second half of the same gap. A cluster's frontier can be
-- fully measured on tool-free items and be the wrong evidence for half the
-- traffic in it; the envelope says so (tools, stream, size) and nothing
-- recorded it.
--
-- ALL FOUR COLUMNS ARE NULLABLE and unwritten by pre-0041 rows. NULL reads
-- as NOT RECORDED, which is true, and never as a zero confidence — a
-- backfilled 0 would look exactly like "nothing we serve fits this", which
-- is the finding this signal exists to make.
--
-- PRIVACY. `shape` is counts, flags and a coarse LENGTH bucket (core/shape.ts,
-- pinned content-free by test); it holds no message text, no tool names, and
-- no embedding. `runner_up_cluster` is a taxonomy id we published. Nothing
-- here is customer content, which is what keeps it inside the existing
-- service-operations basis (PRIVACY_POLICY §1.2) and out of the pending
-- cross-org aggregate decision (S7 §4 D1).

-- Cosine to the winning centroid, as the assigner computed it. Below the
-- routing threshold this is the confidence of a match that was REFUSED —
-- the request went to 'general' — so a low number here on a 'general' row is
-- the untested-demand signal in its rawest form.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cluster_confidence double precision;
--> statement-breakpoint

-- The second-best cluster, and how far behind it was. A 0.02 margin means
-- the router made a coin-flip that the trace reported as a decision; that is
-- worth knowing before it shows up as a quality complaint.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS runner_up_cluster text;
--> statement-breakpoint
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cluster_margin double precision;
--> statement-breakpoint

-- Content-free request structure (core/shape.ts RequestShape).
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS shape jsonb;
--> statement-breakpoint

-- The demand aggregator (L2) reads a time window across ALL orgs and groups
-- by cluster — the one read pattern no existing index serves: 0027's index is
-- (org_id, ts) for per-org latency, 0039's is (org_id, paid_by, ts) for
-- invoicing. Both lead with org_id, and this read has no org in its
-- predicate at all.
CREATE INDEX IF NOT EXISTS request_logs_ts_cluster_idx
  ON request_logs (ts, cluster_id);

-- 0027 — serving-grade latency rollup support (G2.6).
--
-- A compound policy's latency bound is a customer-stated SLO, so it must bind
-- against the SERVING latency distribution rather than the harness benchmark
-- (which is a spread over eval items, on a different span, and an optimistic
-- lower bound on what the SLO actually experiences). That rollup reads
-- request_logs on the serving hot path, and request_logs has carried no index
-- beyond the primary key.
--
-- Partial on status='ok': guarantee_judge / rubric_gen / eval_live rows carry
-- a latency but are not served traffic, and including them would let platform
-- work move a customer's p95. The predicate is in the index so the planner can
-- use it for exactly the query the rollup issues.
CREATE INDEX IF NOT EXISTS request_logs_serving_latency_idx
  ON request_logs (org_id, cluster_id, strategy_hash, ts)
  WHERE status = 'ok';

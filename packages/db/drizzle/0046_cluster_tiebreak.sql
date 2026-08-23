-- Quality-safe cluster tiebreak (2026-08-22). Production's centroid cosines
-- sit at 0.39–0.54 with best/runner-up margins of 0.025–0.069, so the
-- nearest-centroid decision is close to a coin flip for most traffic. When
-- the top two clusters are within the ambiguity margin the request is served
-- under whichever resolves to the higher measured quality, and the row says
-- so, so the tiebreak rate is a number the Observatory can watch.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cluster_tiebreak boolean;

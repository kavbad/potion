-- G (2026-08-23): the first vision leg's cells landed with instrument
-- 'default' because the cell's instrument derived from the SCORER (vision
-- items are field-match) — invisible to the vision aggregation and polluting
-- extraction's default axis. The instrument now comes from the leg; this
-- retags the vision suite's cells, keyed on its item-id prefix, which only
-- that suite uses. Idempotent; touches nothing else.
UPDATE eval_results SET instrument = 'vision' WHERE item_id LIKE 'vis-%';

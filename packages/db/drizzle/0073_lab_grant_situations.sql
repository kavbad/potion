ALTER TABLE lab_action_grants ADD COLUMN IF NOT EXISTS situations jsonb NOT NULL DEFAULT '[]'::jsonb;

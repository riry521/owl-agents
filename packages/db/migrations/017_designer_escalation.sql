ALTER TABLE works ADD COLUMN design_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (design_mode IN ('auto', 'lead'));

ALTER TABLE tasks ADD COLUMN lead_designer_start_round INTEGER NULL
  CHECK (lead_designer_start_round IS NULL OR lead_designer_start_round >= 0);

ALTER TABLE agent_runs ADD COLUMN design_tier TEXT NULL
  CHECK (design_tier IS NULL OR design_tier IN ('standard', 'lead'));

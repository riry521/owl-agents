-- NULL: no per-Task designation (the Work's design_mode decides), or not a design Task.
ALTER TABLE tasks ADD COLUMN assigned_designer TEXT
  CHECK (assigned_designer IS NULL OR assigned_designer IN ('designer', 'lead_designer'));

-- HTML mocks of screen design Tasks, saved by Core through save_design_mock.
-- The preview reads only this table; the files under the mock directory are an export.
CREATE TABLE design_mocks (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, name)
);

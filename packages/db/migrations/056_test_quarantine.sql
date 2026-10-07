CREATE TABLE test_quarantine (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file            TEXT NOT NULL,
  classified_by   TEXT NOT NULL CHECK (classified_by IN ('baseline', 'nightly')),
  failures_json   TEXT NOT NULL CHECK (json_valid(failures_json)),
  quarantined_at  TEXT NOT NULL,
  removal_work_id TEXT NULL REFERENCES works(id) ON DELETE SET NULL,
  PRIMARY KEY (project_id, file)
);

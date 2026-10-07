CREATE TABLE learning_jobs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL UNIQUE REFERENCES works(id),
  agent_run_id TEXT NULL,
  project_id TEXT NULL,
  payload_json TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  result_json TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT NULL
);
CREATE INDEX learning_jobs_status ON learning_jobs(status);

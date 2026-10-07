CREATE TABLE child_runs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  parent_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  request_key TEXT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  write_paths_json TEXT NOT NULL
    CHECK (json_valid(write_paths_json) AND json_type(write_paths_json) = 'array'),
  workspace_dir TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  model TEXT NOT NULL,
  effort TEXT NULL CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  rate_limit_requeues INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_requeues >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  blocked_reason TEXT NULL
    CHECK (blocked_reason IS NULL OR blocked_reason IN ('write_scope', 'concurrency', 'provider_paused')),
  current_agent_run_id TEXT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  summary_json TEXT NULL CHECK (summary_json IS NULL OR json_valid(summary_json)),
  report_text TEXT NULL,
  failure_kind TEXT NULL CHECK (failure_kind IS NULL OR failure_kind IN (
    'timeout', 'idle_timeout', 'exit_code', 'no_final_report', 'reported_error', 'spawn_error',
    'output_limit', 'rate_limited', 'cancelled', 'parent_ended', 'core_restart')),
  failure_reason TEXT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (parent_agent_run_id, seq),
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'queued') OR blocked_reason IS NULL)
);
CREATE UNIQUE INDEX child_runs_request_key ON child_runs(parent_agent_run_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX child_runs_task ON child_runs(task_id, created_at, id);
CREATE INDEX child_runs_active ON child_runs(status, created_at) WHERE status IN ('queued', 'running');

ALTER TABLE agent_runs ADD COLUMN child_run_id TEXT NULL REFERENCES child_runs(id) ON DELETE RESTRICT;
CREATE INDEX agent_runs_child_run ON agent_runs(child_run_id) WHERE child_run_id IS NOT NULL;

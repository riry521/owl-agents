-- child_runs.provider に 'opencode' を足す。SQLite は CHECK を ALTER できないので表を作り直す。
-- agent_runs.child_run_id が child_runs を ON DELETE RESTRICT で参照し、runner は foreign_keys=ON で動く。
-- 参照を退避表へ写して NULL にしてから DROP し、作り直した後で戻す。

CREATE TABLE child_runs_new (
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
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'opencode')),
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
  relay_count INTEGER NOT NULL DEFAULT 0 CHECK (relay_count >= 0),
  handoff_json TEXT NULL CHECK (handoff_json IS NULL OR json_valid(handoff_json)),
  UNIQUE (parent_agent_run_id, seq),
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'queued') OR blocked_reason IS NULL)
);
INSERT INTO child_runs_new (
  id, work_id, task_id, parent_agent_run_id, seq, request_key, title, instruction, write_paths_json, workspace_dir,
  provider, model, effort, timeout_ms, max_attempts, attempt, rate_limit_requeues, status, blocked_reason,
  current_agent_run_id, summary_json, report_text, failure_kind, failure_reason, created_at, started_at, finished_at,
  updated_at, relay_count, handoff_json)
SELECT
  id, work_id, task_id, parent_agent_run_id, seq, request_key, title, instruction, write_paths_json, workspace_dir,
  provider, model, effort, timeout_ms, max_attempts, attempt, rate_limit_requeues, status, blocked_reason,
  current_agent_run_id, summary_json, report_text, failure_kind, failure_reason, created_at, started_at, finished_at,
  updated_at, relay_count, handoff_json
FROM child_runs;

CREATE TABLE agent_run_child_links_copy (id TEXT PRIMARY KEY, child_run_id TEXT NOT NULL);
INSERT INTO agent_run_child_links_copy (id, child_run_id)
  SELECT id, child_run_id FROM agent_runs WHERE child_run_id IS NOT NULL;
UPDATE agent_runs SET child_run_id = NULL WHERE child_run_id IS NOT NULL;

DROP TABLE child_runs;
ALTER TABLE child_runs_new RENAME TO child_runs;
CREATE UNIQUE INDEX child_runs_request_key ON child_runs(parent_agent_run_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX child_runs_task ON child_runs(task_id, created_at, id);
CREATE INDEX child_runs_active ON child_runs(status, created_at) WHERE status IN ('queued', 'running');

UPDATE agent_runs
  SET child_run_id = (SELECT l.child_run_id FROM agent_run_child_links_copy l WHERE l.id = agent_runs.id)
  WHERE id IN (SELECT id FROM agent_run_child_links_copy);
DROP TABLE agent_run_child_links_copy;

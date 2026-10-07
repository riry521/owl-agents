-- Core runs a Project's tests file by file and keeps the result.
--
-- projects.test_run_json: the Project's test-run settings (JSON object) or NULL = Core does not run tests.
-- test_runs: one row per run (a Task check, a Work check, or a baseline checkout).
-- test_run_files: one row per test file in that run.
-- backlog_items is rebuilt (create -> copy -> drop -> rename -> indexes, as in 045)
-- so `source` can also be 'test_run' (one open item per Work).

ALTER TABLE projects ADD COLUMN test_run_json TEXT NULL
  CHECK (test_run_json IS NULL OR (json_valid(test_run_json) AND json_type(test_run_json) = 'object'));

CREATE TABLE test_runs (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_id TEXT NULL REFERENCES works(id) ON DELETE CASCADE,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_run_id TEXT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task', 'work', 'baseline')),
  mode TEXT NOT NULL CHECK (mode IN ('full', 'selected')),
  commit_sha TEXT NOT NULL,
  base_commit TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
  selection_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  error TEXT NULL,
  CHECK (
    (scope = 'task' AND work_id IS NOT NULL AND task_id IS NOT NULL)
    OR (scope = 'work' AND work_id IS NOT NULL AND task_id IS NULL)
    OR (scope = 'baseline' AND work_id IS NULL AND task_id IS NULL)
  )
);
CREATE INDEX test_runs_task ON test_runs(task_id, finished_at);
CREATE INDEX test_runs_work ON test_runs(work_id, scope, finished_at);
CREATE INDEX test_runs_baseline ON test_runs(project_id, scope, commit_sha);

CREATE TABLE test_run_files (
  run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error', 'timed_out')),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  exit_code INTEGER NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  failures_json TEXT NOT NULL DEFAULT '[]',
  output_tail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, file)
);

CREATE TABLE backlog_items_new (
  id TEXT NOT NULL PRIMARY KEY,
  work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  review_id TEXT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
  review_round INTEGER NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  file TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0 CHECK (line >= 0),
  problem TEXT NOT NULL CHECK (length(problem) >= 1),
  reason TEXT NOT NULL DEFAULT '',
  suggestion TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
  issued_work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'review' CHECK (source IN ('review', 'nightly_test', 'test_run')),
  CHECK (
    (status IN ('open', 'dismissed') AND issued_work_id IS NULL)
    OR (status = 'in_progress' AND issued_work_id IS NOT NULL)
    OR status = 'done'
  ),
  CHECK (
    (source = 'review' AND work_id IS NOT NULL AND task_id IS NOT NULL AND review_id IS NOT NULL)
    OR (source = 'nightly_test' AND work_id IS NULL AND task_id IS NULL AND review_id IS NULL)
    OR (source = 'test_run' AND work_id IS NOT NULL AND task_id IS NULL AND review_id IS NULL)
  ),
  UNIQUE (task_id, dedupe_key)
);

INSERT INTO backlog_items_new (
  id, work_id, task_id, project_id, review_id, review_round, file, line,
  problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at, source
)
SELECT
  id, work_id, task_id, project_id, review_id, review_round, file, line,
  problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at, source
FROM backlog_items;

DROP TABLE backlog_items;
ALTER TABLE backlog_items_new RENAME TO backlog_items;

CREATE INDEX backlog_items_status_created ON backlog_items(status, created_at);
CREATE INDEX backlog_items_project_status ON backlog_items(project_id, status);
CREATE INDEX backlog_items_work_id ON backlog_items(work_id);
CREATE INDEX backlog_items_issued_work_id ON backlog_items(issued_work_id);

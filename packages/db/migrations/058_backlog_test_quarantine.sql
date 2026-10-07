-- backlog_items is rebuilt (create -> copy -> drop -> rename -> indexes, as in 048)
-- so `source` can also be 'test_quarantine' (one open item per Project, kept by Core's write lane).

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
  source TEXT NOT NULL DEFAULT 'review' CHECK (source IN ('review', 'nightly_test', 'test_run', 'test_quarantine')),
  CHECK (
    (status IN ('open', 'dismissed') AND issued_work_id IS NULL)
    OR (status = 'in_progress' AND issued_work_id IS NOT NULL)
    OR status = 'done'
  ),
  CHECK (
    (source = 'review' AND work_id IS NOT NULL AND task_id IS NOT NULL AND review_id IS NOT NULL)
    OR (source = 'nightly_test' AND work_id IS NULL AND task_id IS NULL AND review_id IS NULL)
    OR (source = 'test_run' AND work_id IS NOT NULL AND task_id IS NULL AND review_id IS NULL)
    OR (source = 'test_quarantine' AND work_id IS NULL AND task_id IS NULL AND review_id IS NULL)
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

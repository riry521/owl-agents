-- Owl migration identity: migrations/026_backlog_work_link.sql, version '026'.
-- Design: backlog items linked to a Work.
--
-- Adds the in_progress status (linked to a Work that has not completed) and
-- lets a done item outlive its deleted Work (issued_work_id NULL). SQLite
-- cannot ALTER a CHECK constraint in place, so the table is rebuilt:
-- create -> copy -> drop -> rename -> recreate indexes. Nothing references
-- backlog_items, so the rebuild needs no foreign-key toggle.

CREATE TABLE backlog_items_new (
  id TEXT NOT NULL PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
  review_round INTEGER NOT NULL CHECK (review_round >= 0),
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
  CHECK (
    (status IN ('open', 'dismissed') AND issued_work_id IS NULL)
    OR (status = 'in_progress' AND issued_work_id IS NOT NULL)
    OR status = 'done'
  ),
  UNIQUE (task_id, dedupe_key)
);

-- Existing rows keep their status and issued_work_id as they are.
INSERT INTO backlog_items_new (
  id, work_id, task_id, project_id, review_id, review_round, file, line,
  problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at
)
SELECT
  id, work_id, task_id, project_id, review_id, review_round, file, line,
  problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at
FROM backlog_items;

DROP TABLE backlog_items;
ALTER TABLE backlog_items_new RENAME TO backlog_items;

CREATE INDEX backlog_items_status_created ON backlog_items(status, created_at);
CREATE INDEX backlog_items_project_status ON backlog_items(project_id, status);
CREATE INDEX backlog_items_work_id ON backlog_items(work_id);
CREATE INDEX backlog_items_issued_work_id ON backlog_items(issued_work_id);

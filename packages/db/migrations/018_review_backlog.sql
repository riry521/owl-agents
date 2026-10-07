CREATE TABLE backlog_items (
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
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  issued_work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'done') = (issued_work_id IS NOT NULL)),
  UNIQUE (task_id, dedupe_key)
);

CREATE INDEX backlog_items_status_created ON backlog_items(status, created_at);
CREATE INDEX backlog_items_project_status ON backlog_items(project_id, status);
CREATE INDEX backlog_items_work_id ON backlog_items(work_id);
CREATE INDEX backlog_items_issued_work_id ON backlog_items(issued_work_id);

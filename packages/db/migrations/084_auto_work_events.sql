-- One row per signal the automatic Work creation received, with its verdict; skipped signals are kept too.
CREATE TABLE auto_work_events (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('failure_notice', 'scheduled_check', 'github')),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  rule_id TEXT,
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) = 64),
  day_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('judging', 'created', 'duplicate', 'below_threshold', 'daily_cap', 'unauthorized', 'no_rule', 'disabled', 'not_worth', 'judge_failed')),
  verdict_reason TEXT NOT NULL,
  judge_json TEXT CHECK (judge_json IS NULL OR json_valid(judge_json)),
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  duplicate_of_work_id TEXT,
  duplicate_of_event_id TEXT,
  action TEXT CHECK (action IS NULL OR action IN ('draft', 'start')),
  action_error TEXT,
  backlog_item_ids_json TEXT NOT NULL CHECK (json_valid(backlog_item_ids_json)),
  github_repo TEXT,
  github_issue_number INTEGER,
  github_is_pull_request INTEGER,
  github_comment_id TEXT,
  github_updated_at TEXT,
  github_author TEXT,
  github_url TEXT,
  github_comment_url TEXT,
  github_pr_url TEXT,
  finished_notified_at TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX auto_work_events_project_created ON auto_work_events(project_id, created_at);
CREATE INDEX auto_work_events_dedupe ON auto_work_events(dedupe_key, created_at);
CREATE INDEX auto_work_events_day ON auto_work_events(project_id, day_key, verdict);
CREATE INDEX auto_work_events_work ON auto_work_events(work_id);
CREATE INDEX auto_work_events_github ON auto_work_events(github_repo, github_issue_number, kind);
CREATE INDEX auto_work_events_github_comment ON auto_work_events(github_repo, github_comment_id);

-- One row per (project, list): the last fetch time of the GitHub list. No page number or last-seen id is kept.
CREATE TABLE auto_work_github_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  list TEXT NOT NULL CHECK (list IN ('issues', 'comments')),
  repo TEXT NOT NULL,
  since TEXT NOT NULL,
  last_polled_at TEXT,
  last_completed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, list)
);

-- One row per GitHub item the fetch has read; processing marks it processed and drops the payload.
CREATE TABLE auto_work_github_items (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('issue', 'comment')),
  item_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  created_in_window INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processed', 'failed')),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  event_id TEXT,
  seen_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (project_id, item_type, item_id)
);
CREATE INDEX auto_work_github_items_state ON auto_work_github_items(project_id, item_type, state, updated_at, item_id);

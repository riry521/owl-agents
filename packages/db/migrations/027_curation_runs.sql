-- Owl migration identity: migrations/027_curation_runs.sql, version '027'.
-- Records every curation run (Librarian, skill curation, rule curation) so the
-- Owner can review what ran, who started it, and what it changed.
CREATE TABLE curation_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('librarian', 'skill_curation', 'rule_curation')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual_api', 'advisor_action', 'scheduled')),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'advisor', 'system')),
  actor_ref TEXT,
  request_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary TEXT NOT NULL DEFAULT '',
  counts_json TEXT NOT NULL DEFAULT '{}',
  report_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((status = 'running') = (ended_at IS NULL))
);
CREATE INDEX curation_runs_kind_started ON curation_runs (kind, started_at DESC);
CREATE INDEX curation_runs_started ON curation_runs (started_at DESC);

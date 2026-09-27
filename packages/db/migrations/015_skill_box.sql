CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'stale', 'archived')),
  trial INTEGER NOT NULL DEFAULT 0 CHECK (trial IN (0, 1)),
  content_hash TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NULL,
  state_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  broken_reason TEXT NULL
);

CREATE TABLE skill_revisions (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL REFERENCES skills(name),
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('curator', 'user')),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'merge', 'state_change', 'scope_change', 'restore', 'rollback', 'external_edit')),
  snapshot_json TEXT NULL,
  content_hash TEXT NOT NULL,
  source_proposal_id TEXT NULL,
  source_work_id TEXT NULL,
  source_agent_run_id TEXT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (skill_name, revision)
);

CREATE TABLE skill_usages (
  agent_run_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  work_id TEXT NULL,
  project_id TEXT NULL,
  role TEXT NULL,
  revision INTEGER NOT NULL,
  read_detected INTEGER NOT NULL DEFAULT 0 CHECK (read_detected IN (0, 1)),
  verdict TEXT NULL CHECK (verdict IS NULL OR verdict IN ('helpful', 'misleading', 'irrelevant')),
  note TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_run_id, skill_name)
);

CREATE TABLE skill_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'update')),
  target_skill TEXT NULL,
  payload_json TEXT NOT NULL,
  source_work_id TEXT NULL,
  source_agent_run_id TEXT NULL,
  project_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_approval', 'applied', 'rejected')),
  decision_json TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  applied_revision_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX skill_usages_skill_name_revision ON skill_usages(skill_name, revision);
CREATE INDEX skill_proposals_status ON skill_proposals(status);

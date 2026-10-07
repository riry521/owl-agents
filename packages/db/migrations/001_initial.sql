-- Owl MVP migration identity: migrations/001_initial.sql, version '001'.
-- Final column/constraint precedence: §66-1 > §67-F4/F5 > §65-1.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT NOT NULL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  status TEXT NOT NULL CHECK (status = 'APPLIED'),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migration_lock (
  lock_id INTEGER NOT NULL PRIMARY KEY CHECK (lock_id = 1),
  holder_id TEXT NOT NULL CHECK (length(holder_id) BETWEEN 1 AND 128),
  acquired_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  CHECK (lease_expires_at >= acquired_at)
);

INSERT OR IGNORE INTO schema_migration_lock
  (lock_id, holder_id, acquired_at, lease_expires_at)
VALUES (1, 'bootstrap', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

CREATE TABLE IF NOT EXISTS owners (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  canonical_path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL,
  allowed_roots_json TEXT NOT NULL CHECK (json_valid(allowed_roots_json)),
  verification_plan_json TEXT NOT NULL CHECK (json_valid(verification_plan_json)),
  worktree_prepare_argv_json TEXT NOT NULL CHECK (json_valid(worktree_prepare_argv_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  summary TEXT NOT NULL CHECK (length(summary) <= 20000),
  size TEXT NOT NULL CHECK (size IN ('small','normal','large')),
  state TEXT NOT NULL CHECK (state IN ('memo','ready','running','judgement_waiting','paused','completed','cancelled')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  related_work_ids_json TEXT NOT NULL CHECK (json_valid(related_work_ids_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NULL,
  cancelled_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  parent_task_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  type TEXT NOT NULL CHECK (type IN ('research','design','code','config','doc','test')),
  status TEXT NOT NULL CHECK (status IN ('waiting','ready','running','verifying','review_fix_waiting','failed','judgement_waiting','completed','paused','cancelled')),
  review_override TEXT NULL CHECK (review_override IS NULL OR review_override IN ('true','false')),
  priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','critical')),
  context TEXT NOT NULL CHECK (length(context) <= 50000),
  acceptance TEXT NOT NULL CHECK (length(acceptance) <= 50000),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  same_error_count INTEGER NOT NULL DEFAULT 0 CHECK (same_error_count >= 0),
  last_error_key TEXT NULL CHECK (last_error_key IS NULL OR length(last_error_key) = 64),
  last_error_generation INTEGER NULL CHECK (last_error_generation IS NULL OR last_error_generation >= 0),
  review_round INTEGER NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  worker_generation INTEGER NOT NULL DEFAULT 0 CHECK (worker_generation >= 0),
  worktree_path TEXT NULL,
  worktree_state TEXT NULL CHECK (worktree_state IS NULL OR worktree_state IN ('active','merged','conflict_retained','retained','discarded','removed')),
  last_failure_class TEXT NULL CHECK (last_failure_class IS NULL OR last_failure_class IN ('transient','deterministic')),
  paused_from TEXT NULL CHECK (paused_from IS NULL OR paused_from IN ('waiting','ready','review_fix_waiting','failed')),
  cancel_reason TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (last_error_key IS NULL AND last_error_generation IS NULL)
    OR (last_error_key IS NOT NULL AND last_error_generation IS NOT NULL)
  ),
  CHECK (
    (same_error_count = 0 AND last_error_key IS NULL AND last_error_generation IS NULL)
    OR (same_error_count >= 1 AND last_error_key IS NOT NULL AND last_error_generation IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT NOT NULL PRIMARY KEY,
  agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success','failed','partial')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  raw_response_sha256 TEXT NOT NULL CHECK (length(raw_response_sha256) = 64),
  raw_response_bytes INTEGER NOT NULL CHECK (raw_response_bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT NOT NULL PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  parent_agent_id TEXT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  subtask_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('advisor','manager','designer','worker','reviewer','executor')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('launch_pending','spawned','running','exited','completed','failed','spawn_failed','cancel_requested','cancelled')),
  pid INTEGER NULL CHECK (pid IS NULL OR pid > 0),
  process_start_time TEXT NULL,
  process_cmdline_sha256 TEXT NULL CHECK (process_cmdline_sha256 IS NULL OR length(process_cmdline_sha256) = 64),
  started_at TEXT NULL,
  ended_at TEXT NULL,
  last_output_at TEXT NULL,
  lease_expires_at TEXT NULL,
  fencing_token TEXT NULL,
  report_id TEXT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  retry_of_run_id TEXT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  worktree_state TEXT NULL CHECK (worktree_state IS NULL OR worktree_state IN ('active','merged','conflict_retained','retained','discarded','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT NOT NULL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  round INTEGER NOT NULL CHECK (round >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fix_required','replan_required')),
  findings_json TEXT NOT NULL CHECK (json_valid(findings_json)),
  verification_report_json TEXT NOT NULL CHECK (json_valid(verification_report_json)),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, round)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT NOT NULL PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('task','work')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','cancelled')),
  blocked_task_ids_json TEXT NOT NULL CHECK (json_valid(blocked_task_ids_json)),
  reason TEXT NOT NULL,
  tried TEXT NOT NULL,
  current_state TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  recommended TEXT NULL,
  allow_free_text INTEGER NOT NULL CHECK (allow_free_text IN (0,1)),
  issuer_role TEXT NOT NULL CHECK (issuer_role IN ('core','advisor','manager')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at TEXT NOT NULL,
  resolved_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS decision_answers (
  id TEXT NOT NULL PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id) ON DELETE RESTRICT,
  answerer_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
  source TEXT NOT NULL CHECK (source IN ('web','slack','discord','advisor')),
  source_message_id TEXT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('web','slack','discord','general')),
  thread_ref TEXT NULL,
  dm_ref TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  archived_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_accounts (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('slack','discord','web')),
  external_account_id TEXT NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  UNIQUE (provider, external_account_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('slack','discord','web')),
  account_id TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE RESTRICT,
  source_message_id TEXT NOT NULL CHECK (length(source_message_id) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 0 AND 100000),
  attachment_ids_json TEXT NOT NULL CHECK (json_valid(attachment_ids_json)),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, account_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  agent_run_id TEXT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','handled','failed')),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  lease_expires_at TEXT NULL,
  next_attempt_at TEXT NULL,
  handled_at TEXT NULL,
  failed_at TEXT NULL,
  dead_letter_at TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL PRIMARY KEY,
  work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code','design_doc','owner_upload','generated')),
  deliverable INTEGER NOT NULL CHECK (deliverable IN (0,1)),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mime TEXT NOT NULL,
  commit_ref TEXT NULL,
  source_event_id TEXT NULL REFERENCES events(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_deliveries (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('websocket','slack','discord','webhook')),
  provider_message_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','failed','uncertain')),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  lease_expires_at TEXT NULL,
  delivered_at TEXT NULL,
  uncertain_at TEXT NULL,
  last_error_code TEXT NULL,
  UNIQUE (event_id, provider)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 200 AND 599),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('disabled','starting','running','degraded','stopped','failed')),
  pid INTEGER NULL CHECK (pid IS NULL OR pid > 0),
  last_error_code TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id TEXT NOT NULL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  source_message_until TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) <= 50000),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, version_no)
);

CREATE TABLE IF NOT EXISTS agent_activity (
  id TEXT NOT NULL PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('file_edit','command','thinking','status','tool')),
  summary TEXT NOT NULL CHECK (length(summary) <= 500),
  source_event_id TEXT NULL REFERENCES events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_receipts (
  id TEXT NOT NULL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('slack','discord','web')),
  account_id TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE RESTRICT,
  external_message_id TEXT NOT NULL CHECK (length(external_message_id) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  ack_id TEXT NOT NULL UNIQUE,
  message_id TEXT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('accepted','duplicate','rejected')),
  event_id TEXT NULL REFERENCES events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, account_id, external_message_id),
  UNIQUE (provider, account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS inbound_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('slack','discord','web')),
  account_id TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE RESTRICT,
  external_attachment_id TEXT NOT NULL CHECK (length(external_attachment_id) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  work_id TEXT NULL REFERENCES works(id) ON DELETE RESTRICT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  declared_mime TEXT NULL CHECK (declared_mime IS NULL OR length(declared_mime) BETWEEN 1 AND 255),
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes BETWEEN 0 AND 1073741824),
  detected_mime TEXT NULL,
  bytes INTEGER NULL CHECK (bytes IS NULL OR bytes >= 0),
  sha256 TEXT NULL CHECK (sha256 IS NULL OR length(sha256) = 64),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered','receiving','stored','quarantined','rejected')),
  artifact_id TEXT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  completed_at TEXT NULL,
  UNIQUE (provider, external_attachment_id),
  UNIQUE (account_id, idempotency_key),
  CHECK (expires_at >= created_at),
  CHECK (status IN ('registered','receiving') OR bytes IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS secret_records (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  expires_at TEXT NULL,
  revoked_at TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secret_audit (
  id TEXT NOT NULL PRIMARY KEY,
  secret_id TEXT NOT NULL REFERENCES secret_records(id) ON DELETE RESTRICT,
  agent_run_id TEXT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('use','rotate','revoke','expire','deny')),
  result TEXT NOT NULL CHECK (result IN ('allowed','denied','failed')),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS messages_account_provider_insert
BEFORE INSERT ON messages
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM connector_accounts
  WHERE id = NEW.account_id AND provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'messages account/provider mismatch');
END;

CREATE TRIGGER IF NOT EXISTS messages_account_provider_update
BEFORE UPDATE OF provider, account_id ON messages
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM connector_accounts
  WHERE id = NEW.account_id AND provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'messages account/provider mismatch');
END;

CREATE TRIGGER IF NOT EXISTS inbound_receipts_account_provider_insert
BEFORE INSERT ON inbound_receipts
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM connector_accounts
  WHERE id = NEW.account_id AND provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'inbound receipt account/provider mismatch');
END;

CREATE TRIGGER IF NOT EXISTS inbound_uploads_account_provider_insert
BEFORE INSERT ON inbound_uploads
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM connector_accounts
  WHERE id = NEW.account_id AND provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'inbound upload account/provider mismatch');
END;

CREATE TABLE IF NOT EXISTS advisor_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','ending','ended')),
  pid INTEGER NULL,
  process_start_time TEXT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  started_at TEXT NULL,
  last_activity_at TEXT NOT NULL,
  idle_timeout_seconds INTEGER NOT NULL DEFAULT 7200,
  ending_started_at TEXT NULL,
  ended_at TEXT NULL,
  end_reason TEXT NULL CHECK (end_reason IS NULL OR end_reason IN ('idle_timeout','owner_requested','crashed','core_restart','spawn_failed')),
  session_summary_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS advisor_sessions_status ON advisor_sessions(status);
CREATE INDEX IF NOT EXISTS advisor_sessions_conversation ON advisor_sessions(conversation_id);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_active_dm
  ON conversations(dm_ref) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS tasks_work_status ON tasks(work_id, status);
CREATE INDEX IF NOT EXISTS task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
CREATE INDEX IF NOT EXISTS agent_runs_task_status ON agent_runs(task_id, status);
CREATE INDEX IF NOT EXISTS events_status_attempt ON events(status, next_attempt_at, sequence);
CREATE INDEX IF NOT EXISTS outbox_status_attempt ON outbox_deliveries(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS messages_account_created ON messages(provider, account_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS agent_activity_work_created ON agent_activity(work_id, created_at);
CREATE INDEX IF NOT EXISTS secret_audit_secret_created ON secret_audit(secret_id, created_at);
CREATE INDEX IF NOT EXISTS inbound_receipts_account_created ON inbound_receipts(account_id, created_at);
CREATE INDEX IF NOT EXISTS inbound_receipts_message ON inbound_receipts(message_id);
CREATE INDEX IF NOT EXISTS inbound_uploads_account_status ON inbound_uploads(account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS inbound_uploads_work ON inbound_uploads(work_id, created_at);
CREATE INDEX IF NOT EXISTS inbound_uploads_conversation ON inbound_uploads(conversation_id, created_at);

-- Owl migration identity: migrations/002_advisor_persistent_session.sql, version '002'.
-- Design: persistent Advisor session contract.
--
-- Extends advisor_sessions with provider/session-resume metadata, widens the
-- status/end_reason CHECK constraints (SQLite cannot ALTER a CHECK constraint
-- in place, so the table is rebuilt: rename -> create -> copy -> drop), and
-- adds advisor_turns / advisor_compactions for the turn queue and compaction
-- capture introduced by the persistent-session redesign.

ALTER TABLE advisor_sessions ADD COLUMN provider_id TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN harness_id TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN model TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN effort TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN provider_session_id TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN workspace_path TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN transcript_path TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN resumed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE advisor_sessions ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE advisor_sessions ADD COLUMN last_compaction_at TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN context_bridge_source TEXT NULL;
ALTER TABLE advisor_sessions ADD COLUMN last_usage_json TEXT NULL;

-- Widen status/end_reason CHECK constraints via table rebuild. Existing
-- 'running' rows are migrated to 'suspended': the new lifecycle treats an
-- orphaned OS process as unowned but the logical session as resumable, so a
-- pre-migration running session becomes suspended rather than ended
-- (see AdvisorSessionManager.recoverOnStartup).
DROP INDEX IF EXISTS advisor_sessions_status;
DROP INDEX IF EXISTS advisor_sessions_conversation;

ALTER TABLE advisor_sessions RENAME TO advisor_sessions_pre_002;

CREATE TABLE advisor_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','ending','ended','suspended')),
  pid INTEGER NULL,
  process_start_time TEXT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  started_at TEXT NULL,
  last_activity_at TEXT NOT NULL,
  idle_timeout_seconds INTEGER NOT NULL DEFAULT 7200,
  ending_started_at TEXT NULL,
  ended_at TEXT NULL,
  end_reason TEXT NULL CHECK (end_reason IS NULL OR end_reason IN (
    'idle_timeout','owner_requested','crashed','core_restart','spawn_failed',
    'resume_failed','cleared','model_changed'
  )),
  session_summary_id TEXT NULL,
  provider_id TEXT NULL,
  harness_id TEXT NULL,
  model TEXT NULL,
  effort TEXT NULL,
  provider_session_id TEXT NULL,
  workspace_path TEXT NULL,
  transcript_path TEXT NULL,
  resumed_count INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  last_compaction_at TEXT NULL,
  context_bridge_source TEXT NULL,
  last_usage_json TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO advisor_sessions (
  id, status, pid, process_start_time, conversation_id, started_at,
  last_activity_at, idle_timeout_seconds, ending_started_at, ended_at,
  end_reason, session_summary_id, provider_id, harness_id, model, effort,
  provider_session_id, workspace_path, transcript_path, resumed_count,
  compaction_count, last_compaction_at, context_bridge_source, last_usage_json,
  created_at, updated_at
)
SELECT
  id,
  CASE WHEN status = 'running' THEN 'suspended' ELSE status END,
  pid, process_start_time, conversation_id, started_at,
  last_activity_at, idle_timeout_seconds, ending_started_at, ended_at,
  end_reason, session_summary_id, provider_id, harness_id, model, effort,
  provider_session_id, workspace_path, transcript_path, resumed_count,
  compaction_count, last_compaction_at, context_bridge_source, last_usage_json,
  created_at, updated_at
FROM advisor_sessions_pre_002;

DROP TABLE advisor_sessions_pre_002;

CREATE INDEX IF NOT EXISTS advisor_sessions_status ON advisor_sessions(status);
CREATE INDEX IF NOT EXISTS advisor_sessions_conversation ON advisor_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS advisor_sessions_provider_session ON advisor_sessions(provider_session_id);

CREATE TABLE IF NOT EXISTS advisor_turns (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  reply_message_id TEXT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','interrupted')),
  origin_channel TEXT NOT NULL CHECK (origin_channel IN ('web','slack','discord','terminal')),
  origin_ref TEXT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  usage_json TEXT NULL CHECK (usage_json IS NULL OR json_valid(usage_json)),
  error TEXT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT NULL,
  completed_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS advisor_turns_session_status ON advisor_turns(session_id, status);
CREATE INDEX IF NOT EXISTS advisor_turns_conversation_queued ON advisor_turns(conversation_id, queued_at);
CREATE INDEX IF NOT EXISTS advisor_turns_status_queued ON advisor_turns(status, queued_at);

CREATE TABLE IF NOT EXISTS advisor_compactions (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  cause TEXT NOT NULL CHECK (cause IN ('auto','manual')),
  pre_tokens INTEGER NULL CHECK (pre_tokens IS NULL OR pre_tokens >= 0),
  captured INTEGER NOT NULL DEFAULT 0 CHECK (captured IN (0,1)),
  summary_path TEXT NULL,
  transcript_path TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS advisor_compactions_session ON advisor_compactions(session_id);
CREATE INDEX IF NOT EXISTS advisor_compactions_conversation_created ON advisor_compactions(conversation_id, created_at);

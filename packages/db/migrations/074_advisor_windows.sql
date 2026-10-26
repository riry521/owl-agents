-- Owl migration identity: migrations/074_advisor_windows.sql, version '074'.
-- Advisor windows: one general window per Owner plus one window per Project.
-- Each window owns a canonical conversation, at most one live Advisor session,
-- and at most one Slack and one Discord channel binding.

CREATE TABLE advisor_windows (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('general', 'project')),
  project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'general' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX advisor_windows_one_general ON advisor_windows(owner_id) WHERE scope = 'general';
CREATE UNIQUE INDEX advisor_windows_one_per_project ON advisor_windows(owner_id, project_id) WHERE scope = 'project';

ALTER TABLE conversations ADD COLUMN advisor_window_id TEXT NULL REFERENCES advisor_windows(id) ON DELETE SET NULL;
CREATE INDEX conversations_advisor_window ON conversations(advisor_window_id);

ALTER TABLE advisor_sessions ADD COLUMN window_id TEXT NULL REFERENCES advisor_windows(id) ON DELETE SET NULL;
CREATE INDEX advisor_sessions_window ON advisor_sessions(window_id);

CREATE TABLE advisor_channel_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES advisor_windows(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('slack', 'discord')),
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 200),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, channel_id),
  UNIQUE (window_id, provider)
);

-- A 'suspended' row left by migration 002 cannot be resumed; from now on suspended means "idle, resume with provider_session_id".
UPDATE advisor_sessions
   SET status = 'ended', end_reason = 'core_restart', pid = NULL,
       ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'suspended';

-- The window id reuses its canonical conversation id so SQL never has to mint a ULID.
INSERT INTO advisor_windows (id, owner_id, scope, project_id, conversation_id, created_at, updated_at)
SELECT c.id, c.owner_id, 'general', NULL, c.id, c.created_at, c.updated_at
  FROM conversations c
 WHERE c.id = (
   SELECT c2.id FROM conversations c2
    WHERE c2.owner_id = c.owner_id AND c2.archived_at IS NULL AND c2.work_id IS NULL
    ORDER BY (c2.is_active = 1 AND c2.channel = 'web') DESC, c2.updated_at DESC LIMIT 1);

UPDATE conversations
   SET advisor_window_id = (SELECT w.id FROM advisor_windows w WHERE w.owner_id = conversations.owner_id AND w.scope = 'general')
 WHERE work_id IS NULL;

-- Fold live Slack/Discord conversations into the canonical one. Rows are kept (archived), never deleted.
UPDATE messages
   SET conversation_id = (SELECT w.conversation_id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id = messages.conversation_id)
 WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id <> w.conversation_id AND c.channel IN ('slack', 'discord') AND c.archived_at IS NULL);
UPDATE advisor_turns
   SET conversation_id = (SELECT w.conversation_id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id = advisor_turns.conversation_id)
 WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id <> w.conversation_id AND c.channel IN ('slack', 'discord') AND c.archived_at IS NULL);
UPDATE inbound_uploads
   SET conversation_id = (SELECT w.conversation_id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id = inbound_uploads.conversation_id)
 WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id <> w.conversation_id AND c.channel IN ('slack', 'discord') AND c.archived_at IS NULL);
UPDATE conversations
   SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id IN (SELECT c.id FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id WHERE c.id <> w.conversation_id AND c.channel IN ('slack', 'discord') AND c.archived_at IS NULL);

UPDATE advisor_sessions
   SET window_id = (SELECT c.advisor_window_id FROM conversations c WHERE c.id = advisor_sessions.conversation_id);

CREATE UNIQUE INDEX advisor_sessions_one_active_per_window
  ON advisor_sessions(window_id)
  WHERE window_id IS NOT NULL AND status IN ('starting', 'running', 'ending', 'suspended');

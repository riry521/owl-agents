CREATE TABLE work_summary_revisions (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'manager')),
  agent_run_id TEXT NULL,
  trigger_kind TEXT NOT NULL
    CHECK (trigger_kind IN ('owner_edit', 'instruction', 'reopen', 'decision', 'auto_conflict')),
  trigger_message_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(trigger_message_ids_json) AND json_type(trigger_message_ids_json) = 'array'),
  trigger_text TEXT NULL,
  changed_fields_json TEXT NOT NULL
    CHECK (json_valid(changed_fields_json) AND json_type(changed_fields_json) = 'array'),
  title_before TEXT NOT NULL,
  title_after TEXT NOT NULL,
  summary_before TEXT NOT NULL,
  summary_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((actor = 'manager') = (agent_run_id IS NOT NULL)),
  CHECK ((actor = 'owner') = (trigger_kind = 'owner_edit'))
);
CREATE INDEX work_summary_revisions_work ON work_summary_revisions(work_id, created_at, id);

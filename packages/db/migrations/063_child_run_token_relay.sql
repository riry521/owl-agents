ALTER TABLE child_runs ADD COLUMN relay_count INTEGER NOT NULL DEFAULT 0 CHECK (relay_count >= 0);
ALTER TABLE child_runs ADD COLUMN handoff_json TEXT NULL CHECK (handoff_json IS NULL OR json_valid(handoff_json));

-- ON DELETE CASCADE: these are reporting rows, so they must not block deleting a Work's agent_runs.
CREATE TABLE agent_run_requests (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL,
  child_run_id TEXT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  message_id TEXT NOT NULL,
  subagent INTEGER NOT NULL DEFAULT 0 CHECK (subagent IN (0, 1)),
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (agent_run_id, message_id)
);
CREATE INDEX agent_run_requests_model_prompt ON agent_run_requests(model, prompt_tokens);
CREATE INDEX agent_run_requests_work ON agent_run_requests(work_id, created_at);

-- SHA-256 hex of each cache layer of the role prompt and how it was sent, so a cache miss
-- can be traced to the layer that changed. Existing rows stay NULL.
ALTER TABLE agent_runs ADD COLUMN prompt_header_hash TEXT NULL;
ALTER TABLE agent_runs ADD COLUMN prompt_project_hash TEXT NULL;
ALTER TABLE agent_runs ADD COLUMN prompt_task_hash TEXT NULL;
ALTER TABLE agent_runs ADD COLUMN prompt_dynamic_hash TEXT NULL;
ALTER TABLE agent_runs ADD COLUMN prompt_mode TEXT NULL
  CHECK (prompt_mode IS NULL OR prompt_mode IN ('fresh', 'resumed', 'handoff', 'report_resubmit'));

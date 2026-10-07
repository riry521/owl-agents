-- A subagent the Worker's own harness reported through a SubagentStart/Stop hook
-- is an observed child without a process. hook_agent_id is the harness's id for
-- it: it keeps scanSubagents from closing the row for lacking a pid and makes a
-- repeated report land on the same row.
ALTER TABLE agent_runs ADD COLUMN hook_agent_id TEXT NULL;
CREATE UNIQUE INDEX idx_agent_runs_hook_child ON agent_runs(parent_agent_id, hook_agent_id) WHERE hook_agent_id IS NOT NULL;

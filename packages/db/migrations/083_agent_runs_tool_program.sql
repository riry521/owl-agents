-- The first non-shell program between an AgentRun and an agent CLI found below it
-- (python edit-team -> claude -p). The process scan sets it on detection because the
-- process tree is gone when the completion gate runs. NULL: shells and launchers only,
-- started directly, or reported by a hook.
ALTER TABLE agent_runs ADD COLUMN tool_program TEXT NULL;

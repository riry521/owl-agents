-- Subagent visibility.
--   phase:  a Hybrid Worker run records which phase it is in (plan,
--           executing, verdict) while its own process may have exited.
--   subtask_count: how many subtasks the Hybrid Worker planned.
--   label:  what a subagent run is working on (Hybrid subtask, or the
--           command name of an observed agent CLI).
--   origin: for role 'executor' runs, 'spawned' when Owl launched the
--           process (Hybrid Executor) and 'observed' when Core found an agent
--           CLI in the process tree of another run (for example a Worker that
--           runs another agent CLI itself). parent_agent_id links either kind
--           to the run it belongs to.
ALTER TABLE agent_runs ADD COLUMN phase TEXT NULL CHECK (phase IS NULL OR phase IN ('plan','executing','verdict'));
ALTER TABLE agent_runs ADD COLUMN subtask_count INTEGER NULL CHECK (subtask_count IS NULL OR subtask_count >= 0);
ALTER TABLE agent_runs ADD COLUMN label TEXT NULL;
ALTER TABLE agent_runs ADD COLUMN origin TEXT NULL CHECK (origin IS NULL OR origin IN ('spawned','observed'));
CREATE INDEX agent_runs_parent ON agent_runs(parent_agent_id);

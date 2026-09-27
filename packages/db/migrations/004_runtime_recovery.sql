-- Durable retry scheduling and Manager-to-Core task identity mapping.
-- Existing migrations are immutable; these columns are additive so upgrades
-- preserve every Work, Task, and AgentRun already committed.

ALTER TABLE tasks ADD COLUMN manager_task_id TEXT NULL;
ALTER TABLE tasks ADD COLUMN retry_no INTEGER NOT NULL DEFAULT 0 CHECK (retry_no >= 0);
ALTER TABLE tasks ADD COLUMN next_attempt_at TEXT NULL;

CREATE INDEX IF NOT EXISTS tasks_retry_due
  ON tasks(work_id, status, next_attempt_at, priority, created_at);

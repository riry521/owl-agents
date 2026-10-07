-- Task lineage: which original Task a Manager replacement (`replaces`) or a
-- same-id retry descends from, so lineage-wide budgets survive remakes.
-- NULL root means the Task is its own lineage root (every Task created
-- before this migration, and every original plan Task).
ALTER TABLE tasks ADD COLUMN lineage_root_task_id TEXT NULL
  REFERENCES tasks(id) ON DELETE RESTRICT;
-- 1 for an original Task; +1 for each remake (replacement or same-id retry).
ALTER TABLE tasks ADD COLUMN lineage_generation INTEGER NOT NULL DEFAULT 1
  CHECK (lineage_generation >= 1);
-- Direct predecessors this Task replaced (Manager `replaces`), as a JSON array of Task ids.
ALTER TABLE tasks ADD COLUMN replaces_task_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(replaces_task_ids_json));
CREATE INDEX idx_tasks_lineage_root ON tasks(lineage_root_task_id);

-- What a Task's worktree changed at each Core verification, by content hash,
-- so Core can tell a remake that only touched verification paths.
CREATE TABLE task_change_measurements (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  agent_run_id TEXT NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
  lineage_generation INTEGER NOT NULL CHECK (lineage_generation >= 1),
  task_type TEXT NOT NULL,
  measured INTEGER NOT NULL CHECK (measured IN (0, 1)),
  files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_change_measurements_task ON task_change_measurements(task_id, created_at);
CREATE INDEX idx_task_change_measurements_work ON task_change_measurements(work_id);

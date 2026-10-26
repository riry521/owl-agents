-- The clones under the clone root that a Task's tool calls used; verification checks each one against its baseline, also after a restart or a retry.
-- baseline: the clone's git status --porcelain with file hashes when the Task first used it, "" when clean or not created yet.
CREATE TABLE task_clone_uses (
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  clone_exists INTEGER NOT NULL CHECK (clone_exists IN (0, 1)),
  baseline TEXT NOT NULL,
  PRIMARY KEY (task_id, path)
);

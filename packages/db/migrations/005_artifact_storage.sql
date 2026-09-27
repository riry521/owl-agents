-- Keep generated artifact bytes after their Task worktree is removed.
-- Existing rows remain valid with NULL storage_path; new captures populate it.

ALTER TABLE artifacts ADD COLUMN storage_path TEXT NULL;

CREATE INDEX IF NOT EXISTS artifacts_storage_path
  ON artifacts(storage_path);

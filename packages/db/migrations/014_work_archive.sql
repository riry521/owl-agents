ALTER TABLE works ADD COLUMN archived_at TEXT NULL;

CREATE INDEX works_archived_at_id ON works(archived_at, id);

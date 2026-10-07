-- Prerequisite wait: a waiting Task whose prerequisite_json is not NULL is
-- held until every condition holds or the Owner resumes it, even when all
-- its dependencies are completed. NULL = ordinary dependency wait.
ALTER TABLE tasks ADD COLUMN prerequisite_json TEXT NULL
  CHECK (prerequisite_json IS NULL OR json_valid(prerequisite_json));
-- When the current prerequisite wait began (NULL when not waiting on one).
ALTER TABLE tasks ADD COLUMN prerequisite_since TEXT NULL;
CREATE INDEX idx_tasks_prerequisite ON tasks(work_id) WHERE prerequisite_json IS NOT NULL;

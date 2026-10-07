-- Base-sync-only remakes: a Task generation whose only purpose is to bring the
-- base branch into the Task branch and pass its checks again. The Manager
-- marks it per generation; Core counts its usage apart from the lineage's
-- main-work budget (remake_limits.base_sync_lineage_*). 0 for every row that
-- existed before this migration, so past usage counts as main work.
-- The mark of the Task's current generation (rewritten at each retry).
ALTER TABLE tasks ADD COLUMN base_sync_only INTEGER NOT NULL DEFAULT 0
  CHECK (base_sync_only IN (0, 1));
-- How many generations of this Task id were base-sync-only.
ALTER TABLE tasks ADD COLUMN base_sync_generations INTEGER NOT NULL DEFAULT 0
  CHECK (base_sync_generations >= 0);
-- The part of total_review_attempts made in base-sync-only generations.
ALTER TABLE tasks ADD COLUMN base_sync_review_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (base_sync_review_attempts >= 0);
-- The Task's mark when this run was launched.
ALTER TABLE agent_runs ADD COLUMN base_sync_only INTEGER NOT NULL DEFAULT 0
  CHECK (base_sync_only IN (0, 1));
-- The Task's mark when this change was measured.
ALTER TABLE task_change_measurements ADD COLUMN base_sync_only INTEGER NOT NULL DEFAULT 0
  CHECK (base_sync_only IN (0, 1));

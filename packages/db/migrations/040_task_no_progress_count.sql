-- Consecutive "no progress" results of a Task (Worker question / replan request,
-- repeated failures, review-driven replans). Core stops at progress_guard.no_progress_limit.
ALTER TABLE tasks ADD COLUMN no_progress_count INTEGER NOT NULL DEFAULT 0
  CHECK (no_progress_count >= 0);

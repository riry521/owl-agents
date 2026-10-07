-- Valid Reviewer verdicts (pass / fix_required / replan_required) recorded for
-- this Task across Manager replans. Reviewer crashes do not count; review_round
-- stays plan-local and is reset by task.replanned, this counter is not.
ALTER TABLE tasks ADD COLUMN total_review_attempts INTEGER NOT NULL DEFAULT 0;

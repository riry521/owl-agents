-- Reviewer failures (provider or contract errors of the Reviewer itself) are
-- counted separately from Worker failures. The Worker counters are reset on
-- every Worker start and success, so they could never bound a Reviewer that
-- keeps failing. The state reducer keeps this value >= 0 and resets it only on
-- a Manager replan, a resolved Decision, a restored dependency, or completion.

ALTER TABLE tasks ADD COLUMN reviewer_failure_count INTEGER NOT NULL DEFAULT 0;

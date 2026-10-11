-- Fixer escalation: count review rejections per Task and remember when the Task moved to the Fixer.
ALTER TABLE tasks ADD COLUMN review_rejections INTEGER NOT NULL DEFAULT 0
  CHECK (review_rejections >= 0);
ALTER TABLE tasks ADD COLUMN fixer_escalated_rejections INTEGER NULL
  CHECK (fixer_escalated_rejections IS NULL OR fixer_escalated_rejections >= 1);
ALTER TABLE agent_runs ADD COLUMN worker_tier TEXT NULL
  CHECK (worker_tier IS NULL OR worker_tier IN ('standard', 'fixer'));

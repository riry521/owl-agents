-- Core's review routing for a Task: whether the independent Reviewer is required
-- once Core verification has run, and why (base, forced reasons, measured
-- values). NULL for Tasks routed before this column existed; those keep the
-- plan-only decision (review_override, then the Task type).
ALTER TABLE tasks ADD COLUMN review_decision TEXT NULL
  CHECK (review_decision IS NULL OR review_decision IN ('required', 'not_required'));
ALTER TABLE tasks ADD COLUMN review_decision_json TEXT NULL
  CHECK (review_decision_json IS NULL OR json_valid(review_decision_json));

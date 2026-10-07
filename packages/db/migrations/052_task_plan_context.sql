-- The Manager's per-Task context, notes and necessity as written: a JSON {context, notes, necessity}. NULL for Tasks planned before this column; their tasks.context is read whole.
ALTER TABLE tasks ADD COLUMN plan_context_json TEXT NULL
  CHECK (plan_context_json IS NULL OR json_valid(plan_context_json));

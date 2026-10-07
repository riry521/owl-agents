ALTER TABLE projects ADD COLUMN test_policy_json TEXT NULL
  CHECK (test_policy_json IS NULL OR (json_valid(test_policy_json) AND json_type(test_policy_json) = 'object'));

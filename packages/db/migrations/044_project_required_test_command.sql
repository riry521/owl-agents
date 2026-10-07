ALTER TABLE projects ADD COLUMN required_test_argv_json TEXT
  CHECK (required_test_argv_json IS NULL OR (json_valid(required_test_argv_json) AND json_type(required_test_argv_json) = 'array'));

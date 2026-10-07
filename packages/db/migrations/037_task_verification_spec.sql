-- Per-Task verification spec chosen by the Manager: {"required_sections": [...], "required_tests": [...]}.
ALTER TABLE tasks ADD COLUMN verification_spec_json TEXT NULL
  CHECK (verification_spec_json IS NULL OR json_valid(verification_spec_json));

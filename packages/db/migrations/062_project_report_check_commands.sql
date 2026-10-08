-- Commands the Worker runs before reporting (shell command strings), chosen by the Owner.
-- NULL = not set: Core falls back to the detected test command, then to the project's documentation.
ALTER TABLE projects ADD COLUMN report_check_commands_json TEXT NULL
  CHECK (report_check_commands_json IS NULL OR (json_valid(report_check_commands_json) AND json_type(report_check_commands_json) = 'array'));

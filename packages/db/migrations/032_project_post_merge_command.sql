ALTER TABLE projects ADD COLUMN post_merge_argv_json TEXT
  CHECK (post_merge_argv_json IS NULL OR (json_valid(post_merge_argv_json) AND json_type(post_merge_argv_json) = 'array'));

-- How much a Task changes screens (the Manager's declaration), and the Project's screen file paths as {"include": [...], "exclude": [...]} (NULL: not set).
ALTER TABLE tasks ADD COLUMN ui_change TEXT NOT NULL DEFAULT 'none'
  CHECK (ui_change IN ('none', 'minor', 'major'));
ALTER TABLE projects ADD COLUMN screen_paths_json TEXT NULL
  CHECK (screen_paths_json IS NULL OR (json_valid(screen_paths_json) AND json_type(screen_paths_json) = 'object'));

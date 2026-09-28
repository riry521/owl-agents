ALTER TABLE projects ADD COLUMN worktree_refresh_argv_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(worktree_refresh_argv_json));
ALTER TABLE projects ADD COLUMN worktree_tool_state_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(worktree_tool_state_json));

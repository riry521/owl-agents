-- Language of the commit messages Core writes for a Project. NULL means not set (Core falls back to Japanese).
ALTER TABLE projects ADD COLUMN commit_language TEXT CHECK (commit_language IS NULL OR commit_language IN ('ja', 'en'));

-- Test setups an agent investigated and Core confirmed, one per place they were found.
--
-- projects: found in the canonical checkout. works / tasks: found in that Work's checkout or Task's worktree.
-- A run writes only the row of the place it ran in; a reader picks the record whose digests match its checkout.
-- projects.test_run_json stays the Owner's explicit settings and wins over these columns.
ALTER TABLE projects ADD COLUMN test_setup_json TEXT NULL
  CHECK (test_setup_json IS NULL OR (json_valid(test_setup_json) AND json_type(test_setup_json) = 'object'));
ALTER TABLE works ADD COLUMN test_setup_json TEXT NULL
  CHECK (test_setup_json IS NULL OR (json_valid(test_setup_json) AND json_type(test_setup_json) = 'object'));
ALTER TABLE tasks ADD COLUMN test_setup_json TEXT NULL
  CHECK (test_setup_json IS NULL OR (json_valid(test_setup_json) AND json_type(test_setup_json) = 'object'));

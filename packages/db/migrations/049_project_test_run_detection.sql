-- Core's automatic detection of how to run a Project's tests.
--
-- projects.test_run_json stays the Owner's explicit settings; NULL now means "detect automatically"
-- (an explicit {"mode":"off"} turns Core's test run off).
-- projects.test_run_detected_json: the last detection Core made, or NULL = not detected yet.
ALTER TABLE projects ADD COLUMN test_run_detected_json TEXT NULL
  CHECK (test_run_detected_json IS NULL OR (json_valid(test_run_detected_json) AND json_type(test_run_detected_json) = 'object'));

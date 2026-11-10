-- 1 when the Work's final Core test run must run the whole suite whatever the diff
-- (the Manager asked for it, or a Task criterion that asked for it was removed).
ALTER TABLE works ADD COLUMN full_test_run_at_end INTEGER NOT NULL DEFAULT 0 CHECK (full_test_run_at_end IN (0, 1));

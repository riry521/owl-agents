-- Nothing reads test_run_files.output_tail of a passed file (loadRecord reads file, status and failures_json),
-- and those rows were most of the database size. New passed rows are stored empty by recordTestRunInTransaction.
-- OwlDatabase.migrate runs VACUUM once after this migration is applied; VACUUM cannot run inside the migration transaction.
UPDATE test_run_files SET output_tail = '' WHERE status = 'passed' AND output_tail <> '';

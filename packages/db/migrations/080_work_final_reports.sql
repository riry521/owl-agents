-- Owl migration identity: migrations/080_work_final_reports.sql, version '080'.
-- The final report Manager writes when a Work completes; the primary key keeps it to one per Work.
CREATE TABLE work_final_reports (
  work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  test_results TEXT NOT NULL,
  issues TEXT NOT NULL,
  created_at TEXT NOT NULL
);

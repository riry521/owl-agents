-- Core.start() looks up completed Works with EXISTS subqueries on
-- (work_id, type); without this index each lookup scans events.
CREATE INDEX IF NOT EXISTS idx_events_work_type_sequence ON events(work_id, type, sequence);

-- Owl migration identity: migrations/078_provider_error_records.sql, version '078'.
-- The provider's own error (masked, bounded) for each failed provider call.
CREATE TABLE provider_error_records (
  id TEXT NOT NULL PRIMARY KEY,
  invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 200),
  role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 40),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX provider_error_records_invocation ON provider_error_records(invocation_id, created_at);
CREATE INDEX provider_error_records_created ON provider_error_records(created_at);

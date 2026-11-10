-- These five tables have no INSERT or SELECT in src and no foreign key from a kept table.
-- secret_audit references secret_records, so it is dropped first.
DROP TABLE IF EXISTS secret_audit;
DROP TABLE IF EXISTS secret_records;
DROP TABLE IF EXISTS agent_activity;
DROP TABLE IF EXISTS conversation_summaries;
DROP TABLE IF EXISTS services;

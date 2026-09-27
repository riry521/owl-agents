ALTER TABLE conversations ADD COLUMN triaged_at TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN triage_kept_pairs INTEGER DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN triage_total_pairs INTEGER DEFAULT NULL;

-- rule_proposal_sources.source_kind に 'metrics_snapshot' を足す。CHECK は ALTER できないので表を作り直す。
-- 子表なので親（rule_proposals）には触れず、新表へ写して差し替える。索引は旧表の DROP で消えるので作り直す。

CREATE TABLE rule_proposal_sources_new (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('work', 'note', 'legacy_policy', 'decision', 'metrics_snapshot')),
  source_ref TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES rule_proposals(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_kind, source_ref, input_fingerprint)
);
INSERT INTO rule_proposal_sources_new (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
  SELECT id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at FROM rule_proposal_sources;
DROP TABLE rule_proposal_sources;
ALTER TABLE rule_proposal_sources_new RENAME TO rule_proposal_sources;
CREATE INDEX rule_proposal_sources_proposal ON rule_proposal_sources(proposal_id);
CREATE INDEX rule_proposal_sources_text ON rule_proposal_sources(text_fingerprint);

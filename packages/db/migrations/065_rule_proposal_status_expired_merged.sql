-- rule_proposals.status に 'expired'（期限切れ）と 'merged'（言い換え重複として古い提案へ統合済み）を足す。
-- SQLite は CHECK を ALTER できないので表を作り直す。057 と同じく sources を FK の無い退避表へ写してから子→親の順に DROP し、
-- 059 の定義（source_kind に metrics_snapshot を含む）で sources を戻す。理由は各行の decision_json に入れる。

CREATE TABLE rule_proposals_new (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('lesson', 'note', 'legacy_policy', 'metrics')),
  level TEXT NOT NULL CHECK (level IN ('system', 'role')),
  role TEXT NULL,
  text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  applies_to TEXT NOT NULL,
  note_id TEXT NULL,
  source_work_ids_json TEXT NOT NULL,
  project_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_approval', 'applied', 'rejected', 'expired', 'merged')),
  decision_json TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  applied_rule_id TEXT NULL,
  applied_path TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((level = 'system' AND role IS NULL) OR (level = 'role' AND role IS NOT NULL))
);
INSERT INTO rule_proposals_new (id, fingerprint, origin, level, role, text, rationale, applies_to, note_id, source_work_ids_json, project_id, status, decision_json, attempts, last_error, applied_rule_id, applied_path, created_at, updated_at)
  SELECT id, fingerprint, origin, level, role, text, rationale, applies_to, note_id, source_work_ids_json, project_id, status, decision_json, attempts, last_error, applied_rule_id, applied_path, created_at, updated_at
  FROM rule_proposals;

CREATE TABLE rule_proposal_sources_copy (
  id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL, proposal_id TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO rule_proposal_sources_copy (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
  SELECT id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at FROM rule_proposal_sources;

DROP TABLE rule_proposal_sources;
DROP TABLE rule_proposals;

ALTER TABLE rule_proposals_new RENAME TO rule_proposals;
CREATE INDEX rule_proposals_status ON rule_proposals(status);
CREATE UNIQUE INDEX rule_proposals_open_key
  ON rule_proposals(fingerprint, level, COALESCE(role, ''))
  WHERE status IN ('pending', 'awaiting_approval');
CREATE INDEX rule_proposals_key ON rule_proposals(fingerprint, level, COALESCE(role, ''));

CREATE TABLE rule_proposal_sources (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('work', 'note', 'legacy_policy', 'decision', 'metrics_snapshot')),
  source_ref TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES rule_proposals(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_kind, source_ref, input_fingerprint)
);
INSERT INTO rule_proposal_sources (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
  SELECT id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at FROM rule_proposal_sources_copy;
DROP TABLE rule_proposal_sources_copy;
CREATE INDEX rule_proposal_sources_proposal ON rule_proposal_sources(proposal_id);
CREATE INDEX rule_proposal_sources_text ON rule_proposal_sources(text_fingerprint);

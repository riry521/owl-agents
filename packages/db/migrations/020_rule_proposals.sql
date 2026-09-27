CREATE TABLE rule_proposals (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('lesson', 'note', 'legacy_policy')),
  level TEXT NOT NULL CHECK (level IN ('system', 'role')),
  role TEXT NULL,
  text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  applies_to TEXT NOT NULL,
  note_id TEXT NULL,
  source_work_ids_json TEXT NOT NULL,
  project_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_approval', 'applied', 'rejected')),
  decision_json TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  applied_rule_id TEXT NULL,
  applied_path TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((level = 'system' AND role IS NULL) OR (level = 'role' AND role IS NOT NULL))
);
CREATE INDEX rule_proposals_status ON rule_proposals(status);
CREATE UNIQUE INDEX rule_proposals_open_key
  ON rule_proposals(fingerprint, level, COALESCE(role, ''))
  WHERE status IN ('pending', 'awaiting_approval');
CREATE INDEX rule_proposals_key ON rule_proposals(fingerprint, level, COALESCE(role, ''));

CREATE TABLE rule_proposal_sources (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('work', 'note', 'legacy_policy', 'decision')),
  source_ref TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES rule_proposals(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_kind, source_ref, input_fingerprint)
);
CREATE INDEX rule_proposal_sources_proposal ON rule_proposal_sources(proposal_id);
CREATE INDEX rule_proposal_sources_text ON rule_proposal_sources(text_fingerprint);

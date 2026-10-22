-- A Work waits until every listed Work is completed. The listed Works may belong to any Project.
-- prerequisite_work_id has no foreign key: a deleted prerequisite must stay listed so the wait can stop.
CREATE TABLE work_prerequisites (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  prerequisite_work_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  -- The open Decision that asked the Owner about this prerequisite; set when it became unreachable.
  decision_id TEXT NULL,
  -- What the prerequisite was when it was deleted: {deleted_at, state, title, project_id, project_name, display_number}.
  deleted_json TEXT NULL CHECK (deleted_json IS NULL OR json_valid(deleted_json)),
  PRIMARY KEY (work_id, prerequisite_work_id),
  CHECK (work_id <> prerequisite_work_id)
);
CREATE INDEX work_prerequisites_by_prerequisite ON work_prerequisites(prerequisite_work_id);

-- The Owner's display order of Project windows. Keyed by the window key (the project id) because a Project window needs no advisor_windows row to be listed.
CREATE TABLE advisor_window_order (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  window_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (owner_id, window_key)
);

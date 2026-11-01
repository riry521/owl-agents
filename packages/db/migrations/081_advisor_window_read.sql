-- Messages in the order they were stored. received_at and the ULID id cannot order replies that land in the same millisecond, and the implicit rowid of messages may be renumbered by VACUUM, so arrival gets its own AUTOINCREMENT key that only grows.
CREATE TABLE message_arrival (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE
);

INSERT INTO message_arrival (message_id) SELECT id FROM messages ORDER BY received_at, id;

CREATE TRIGGER message_arrival_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_arrival (message_id) VALUES (NEW.id);
END;

CREATE TRIGGER message_arrival_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_arrival WHERE message_id = OLD.id;
END;

-- How far the Owner has read each window, as the message_arrival.seq of the last Advisor reply shown. Keyed by window key (general or project id) like advisor_window_order; a window with no row has unread every reply.
CREATE TABLE advisor_window_read (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  window_key TEXT NOT NULL,
  read_through_seq INTEGER NOT NULL,
  PRIMARY KEY (owner_id, window_key)
);

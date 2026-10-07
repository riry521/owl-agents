ALTER TABLE messages ADD COLUMN metadata_json TEXT NULL
  CHECK (metadata_json IS NULL OR json_valid(metadata_json));

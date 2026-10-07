-- Where the Owner restarted this Task's lineage budget (an answer to a
-- Decision that blocked it). NULL: never restarted. JSON object:
-- {"at": ISO time, "review_attempts": n, "base_sync_review_attempts": n,
--  "lineage_generation": n, "base_sync_generations": n} = the Task's own
-- counters at that moment; usage counts only what came after.
ALTER TABLE tasks ADD COLUMN lineage_reset_json TEXT NULL
  CHECK (lineage_reset_json IS NULL OR json_valid(lineage_reset_json));

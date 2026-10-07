-- Backlog items an Advisor linked to / dismissed from a Work at creation: a JSON {linked, dismissed}. NULL for Works created before this column; their summary ends with the same list.
ALTER TABLE works ADD COLUMN advisor_backlog_json TEXT NULL
  CHECK (advisor_backlog_json IS NULL OR json_valid(advisor_backlog_json));

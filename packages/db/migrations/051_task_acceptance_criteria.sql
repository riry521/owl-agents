-- Structured acceptance criteria chosen by the Manager: a JSON array of {id, text, check, serves, if_omitted, check_weight, weight_reason}. NULL for Tasks planned with a free-text acceptance.
ALTER TABLE tasks ADD COLUMN acceptance_criteria_json TEXT NULL
  CHECK (acceptance_criteria_json IS NULL OR json_valid(acceptance_criteria_json));

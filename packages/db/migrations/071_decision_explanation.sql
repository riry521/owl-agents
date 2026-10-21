-- What Core tells the Owner first about a stop: a short reason and its cause kind.
-- The fix options themselves live in options_json, so buttons and answers keep working unchanged.
ALTER TABLE decisions ADD COLUMN explanation_json TEXT NULL
  CHECK (explanation_json IS NULL OR json_valid(explanation_json));

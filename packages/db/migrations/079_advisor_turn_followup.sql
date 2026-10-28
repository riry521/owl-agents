-- Owl migration identity: migrations/079_advisor_turn_followup.sql, version '079'.
-- A follow-up turn points at the reply it follows up; the unique index allows one follow-up per source turn.
ALTER TABLE advisor_turns ADD COLUMN followup_of_turn_id TEXT NULL;
CREATE UNIQUE INDEX advisor_turns_followup_of_turn_id
  ON advisor_turns(followup_of_turn_id)
  WHERE followup_of_turn_id IS NOT NULL;

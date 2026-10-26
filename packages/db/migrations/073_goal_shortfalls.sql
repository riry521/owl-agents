-- Goal criteria a Task or Work did not meet, with why. NULL means no record and reads as [].
-- tasks: GoalShortfall[]; works: WorkGoalRecord[] (see packages/shared/src/acceptance-criteria.ts).
ALTER TABLE tasks ADD COLUMN goal_shortfalls_json TEXT NULL CHECK (goal_shortfalls_json IS NULL OR json_valid(goal_shortfalls_json));
ALTER TABLE works ADD COLUMN goal_shortfalls_json TEXT NULL CHECK (goal_shortfalls_json IS NULL OR json_valid(goal_shortfalls_json));

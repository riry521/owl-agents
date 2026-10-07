ALTER TABLE tasks ADD COLUMN design_escalated INTEGER NOT NULL DEFAULT 0 CHECK (design_escalated IN (0, 1));
-- Before this column, a non-NULL lead_designer_start_round outside design_mode=lead could only come from an escalation.
UPDATE tasks SET design_escalated = 1
 WHERE lead_designer_start_round IS NOT NULL
   AND work_id IN (SELECT id FROM works WHERE design_mode <> 'lead');

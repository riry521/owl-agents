ALTER TABLE works ADD COLUMN display_number INTEGER NULL;

ALTER TABLE projects ADD COLUMN next_work_number INTEGER NOT NULL DEFAULT 1;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS display_number
    FROM works
)
UPDATE works
   SET display_number = (SELECT display_number FROM ranked WHERE ranked.id = works.id);

UPDATE projects
   SET next_work_number = COALESCE((SELECT MAX(display_number) FROM works WHERE works.project_id = projects.id), 0) + 1;

-- Works without a Project keep their counter in settings.
INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
SELECT 'work_next_display_number', owner_id, '1.0.0', CAST(MAX(display_number) + 1 AS TEXT),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM works
 WHERE project_id IS NULL
HAVING COUNT(*) > 0;

CREATE UNIQUE INDEX works_project_display_number
  ON works(COALESCE(project_id, ''), display_number)
  WHERE display_number IS NOT NULL;

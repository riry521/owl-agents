-- A Task that failed only because one of its dependencies failed (Task row 27)
-- now carries the id of that dependency. Detecting such a Task by "its latest
-- event is task.dependency_failed" broke as soon as any later event (a pause,
-- a resume) was recorded for it, so cascaded Tasks were handed to the Manager
-- and blocked by Decisions like root failures. The state reducer sets the
-- column on task.dependency_failed and clears it whenever the Task leaves
-- that failure (restored, replanned, superseded, resolved, cancelled).

ALTER TABLE tasks ADD COLUMN failed_by_dependency_task_id TEXT NULL;

-- Backfill with the detection the code used before this migration.
UPDATE tasks
   SET failed_by_dependency_task_id = (
         SELECT json_extract(events.payload_json, '$.failed_dependency_task_id')
           FROM events WHERE events.task_id = tasks.id
          ORDER BY events.sequence DESC LIMIT 1)
 WHERE status = 'failed'
   AND (SELECT events.type FROM events WHERE events.task_id = tasks.id
         ORDER BY events.sequence DESC LIMIT 1) = 'task.dependency_failed';

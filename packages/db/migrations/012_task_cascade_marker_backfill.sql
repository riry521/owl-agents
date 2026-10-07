-- The 011 backfill only marked Tasks with status = 'failed' whose latest event
-- of any type was task.dependency_failed. A cascaded Task that was paused when
-- the migration ran (status = 'paused', paused_from = 'failed'), or that had a
-- Task-scoped event of another type after the cascade, stayed unmarked and was
-- treated as a root failure. Decide again from the latest Task-scoped event
-- that can put a Task into (or take it out of) failed. Idempotent: only rows
-- still without a marker are updated.

UPDATE tasks
   SET failed_by_dependency_task_id = (
         SELECT json_extract(e.payload_json, '$.failed_dependency_task_id')
           FROM events e
          WHERE e.task_id = tasks.id
            AND e.type IN ('task.dependency_failed', 'task.dependency_restored',
                           'task.failure.classified', 'agent.crashed', 'agent.exited',
                           'verification.completed', 'review.failed', 'review.passed',
                           'task.replan_requested')
          ORDER BY e.sequence DESC LIMIT 1)
 WHERE failed_by_dependency_task_id IS NULL
   AND (status = 'failed' OR (status = 'paused' AND paused_from = 'failed'))
   AND (SELECT e.type FROM events e
         WHERE e.task_id = tasks.id
           AND e.type IN ('task.dependency_failed', 'task.dependency_restored',
                          'task.failure.classified', 'agent.crashed', 'agent.exited',
                          'verification.completed', 'review.failed', 'review.passed',
                          'task.replan_requested')
         ORDER BY e.sequence DESC LIMIT 1) = 'task.dependency_failed';

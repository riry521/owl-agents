-- A Task the Manager's replan retired (replaced or cancelled) is hidden from
-- the Work's Task list and progress. The row and its events stay for lineage totals and Decision references.
ALTER TABLE tasks ADD COLUMN superseded_at TEXT NULL;

-- Backfill: a Task named in a task.superseded event, or a cancelled Task in a
-- Work that is not itself cancelled (only a replan retires a Task there; an
-- Owner's cancel always cancels the whole Work).
UPDATE tasks SET superseded_at = COALESCE((
  SELECT MIN(events.created_at) FROM events, json_each(events.payload_json, '$.task_ids')
   WHERE events.type = 'task.superseded' AND json_each.value = tasks.id
), updated_at)
WHERE status = 'cancelled' AND (
  EXISTS (
    SELECT 1 FROM events, json_each(events.payload_json, '$.task_ids')
     WHERE events.type = 'task.superseded' AND json_each.value = tasks.id)
  OR EXISTS (SELECT 1 FROM works WHERE works.id = tasks.work_id AND works.state <> 'cancelled'));

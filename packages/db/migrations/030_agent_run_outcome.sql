-- A completed AgentRun records what its valid result said; `failed` is kept for
-- runs that could not produce a valid result.
ALTER TABLE agent_runs ADD COLUMN outcome TEXT NULL CHECK (outcome IS NULL OR outcome IN ('success','redo','replan','question','partial','not_achieved'));

-- Reviewer runs: the review row shares the run id.
UPDATE agent_runs
   SET outcome = (SELECT CASE reviews.verdict
                            WHEN 'pass' THEN 'success'
                            WHEN 'fix_required' THEN 'redo'
                            WHEN 'replan_required' THEN 'replan'
                          END
                    FROM reviews WHERE reviews.id = agent_runs.id),
       status = 'completed'
 WHERE role = 'reviewer'
   AND status IN ('completed','failed')
   AND EXISTS (SELECT 1 FROM reviews WHERE reviews.id = agent_runs.id AND reviews.verdict IN ('pass','fix_required','replan_required'));

-- Worker and Designer runs that stored a report.
UPDATE agent_runs
   SET outcome = (SELECT CASE
                            WHEN json_type(reports.payload_json, '$.question_for_manager') = 'text'
                                 AND trim(json_extract(reports.payload_json, '$.question_for_manager')) <> '' THEN 'question'
                            WHEN json_extract(reports.payload_json, '$.needs_replanning') IN (1, 'true') OR json_extract(reports.payload_json, '$.verdict') = 'needs_replanning' THEN 'replan'
                            WHEN json_extract(reports.payload_json, '$.verdict') = 'retry' THEN 'redo'
                            WHEN reports.result = 'success' THEN 'success'
                            WHEN reports.result = 'partial' THEN 'partial'
                            ELSE 'not_achieved'
                          END
                    FROM reports WHERE reports.agent_run_id = agent_runs.id),
       status = 'completed'
 WHERE role IN ('worker','designer')
   AND status IN ('completed','failed')
   AND EXISTS (SELECT 1 FROM reports WHERE reports.agent_run_id = agent_runs.id);

-- Hybrid Worker runs that asked for a retry stored no report; the event
-- recorded for the run identifies them.
UPDATE agent_runs
   SET outcome = 'redo', status = 'completed'
 WHERE role = 'worker'
   AND status = 'failed'
   AND outcome IS NULL
   AND EXISTS (
     SELECT 1 FROM events
      WHERE events.agent_run_id = agent_runs.id
        AND events.type = 'task.failure.classified'
        AND json_extract(events.payload_json, '$.error_key') = 'hybrid_worker_retry_requested');

-- Remaining completed runs produced a valid result.
UPDATE agent_runs SET outcome = 'success' WHERE status = 'completed' AND outcome IS NULL;

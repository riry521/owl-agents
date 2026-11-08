// Shared with tests/core/events-work-type-index.test.mjs so the EXPLAIN QUERY
// PLAN check runs the same SQL as Core.start().
export const COMPLETED_PROJECT_WORKS_SQL = `SELECT works.id AS id FROM works
        WHERE works.state = 'completed' AND works.project_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM events WHERE events.work_id = works.id AND events.type = 'work.completed'
                        AND json_extract(events.payload_json, '$.merge') IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM events WHERE events.work_id = works.id AND events.type = 'work.branches_deleted')`;

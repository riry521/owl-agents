CREATE TABLE manager_replan_triggers (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'attempted')),
  question TEXT NULL,
  question_only INTEGER NOT NULL DEFAULT 0 CHECK (question_only IN (0, 1)),
  budget_recovery INTEGER NOT NULL DEFAULT 0 CHECK (budget_recovery IN (0, 1)),
  partial_recovery INTEGER NOT NULL DEFAULT 0 CHECK (partial_recovery IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO manager_replan_triggers
  (task_id, status, question, question_only, budget_recovery, partial_recovery, created_at, updated_at)
SELECT t.id,
       json_extract(s.j, '$.status'),
       CASE WHEN json_type(s.j, '$.question') = 'text' THEN json_extract(s.j, '$.question') END,
       CASE WHEN json_type(s.j, '$.question_only') = 'true' THEN 1 ELSE 0 END,
       CASE WHEN json_type(s.j, '$.budget_recovery') = 'true' THEN 1 ELSE 0 END,
       CASE WHEN json_type(s.j, '$.partial_recovery') = 'true' THEN 1 ELSE 0 END,
       s.created_at,
       s.created_at
  FROM (SELECT substr(key, 17) AS task_id, created_at,
               CASE WHEN json_type(response_json) = 'object' THEN response_json ELSE '{}' END AS j
          FROM idempotency_keys
         WHERE substr(key, 1, 16) = 'manager-trigger:') AS s
  JOIN tasks AS t ON t.id = s.task_id
 WHERE json_extract(s.j, '$.status') IN ('queued', 'attempted');

DELETE FROM idempotency_keys
 WHERE substr(key, 1, 16) = 'manager-trigger:';

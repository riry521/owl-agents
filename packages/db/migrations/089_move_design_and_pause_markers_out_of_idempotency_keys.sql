CREATE TABLE design_handoffs (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  handed_at TEXT NOT NULL
);

CREATE TABLE paused_reviewer_waits (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  recorded_at TEXT NOT NULL
);

INSERT INTO design_handoffs (task_id, handed_at)
SELECT t.id, k.created_at
  FROM idempotency_keys AS k
  JOIN tasks AS t ON t.id = substr(k.key, 18)
 WHERE substr(k.key, 1, 17) = 'design-completed:';

INSERT INTO paused_reviewer_waits (task_id, provider, recorded_at)
SELECT t.id, json_extract(s.j, '$.provider'), s.created_at
  FROM (SELECT substr(key, 22) AS task_id, created_at,
               CASE WHEN json_type(response_json) = 'object' THEN response_json ELSE '{}' END AS j
          FROM idempotency_keys
         WHERE substr(key, 1, 21) = 'paused-reviewer-wait:') AS s
  JOIN tasks AS t ON t.id = s.task_id
 WHERE json_type(s.j, '$.provider') = 'text'
   AND json_extract(s.j, '$.provider') <> ''
   AND json_extract(s.j, '$.task_id') = t.id;

DELETE FROM idempotency_keys
 WHERE substr(key, 1, 17) = 'design-completed:'
    OR substr(key, 1, 21) = 'paused-reviewer-wait:';

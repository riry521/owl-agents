CREATE TABLE owner_replan_requests (
  work_id TEXT NOT NULL PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'attempted')),
  kind TEXT NOT NULL,
  answer TEXT NOT NULL,
  requests_json TEXT NULL CHECK (requests_json IS NULL OR (json_valid(requests_json) AND json_type(requests_json) = 'array')),
  message_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(message_ids_json) AND json_type(message_ids_json) = 'array'),
  processing_kind TEXT NULL,
  processing_answer TEXT NULL,
  processing_requests_json TEXT NULL CHECK (processing_requests_json IS NULL OR (json_valid(processing_requests_json) AND json_type(processing_requests_json) = 'array')),
  processing_message_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(processing_message_ids_json) AND json_type(processing_message_ids_json) = 'array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO owner_replan_requests
  (work_id, status, kind, answer, requests_json, message_ids_json,
   processing_kind, processing_answer, processing_requests_json, processing_message_ids_json,
   created_at, updated_at)
SELECT w.id,
       json_extract(s.j, '$.status'),
       CASE WHEN json_type(s.j, '$.kind') = 'text' THEN json_extract(s.j, '$.kind') ELSE 'decision' END,
       json_extract(s.j, '$.answer'),
       CASE WHEN json_type(s.j, '$.requests') = 'array' THEN json_extract(s.j, '$.requests') END,
       CASE WHEN json_type(s.j, '$.message_ids') = 'array' THEN json_extract(s.j, '$.message_ids') ELSE '[]' END,
       CASE WHEN json_type(s.j, '$.processing_kind') = 'text' THEN json_extract(s.j, '$.processing_kind') END,
       CASE WHEN json_type(s.j, '$.processing_answer') = 'text' THEN json_extract(s.j, '$.processing_answer') END,
       CASE WHEN json_type(s.j, '$.processing_requests') = 'array' THEN json_extract(s.j, '$.processing_requests') END,
       CASE WHEN json_type(s.j, '$.processing_message_ids') = 'array' THEN json_extract(s.j, '$.processing_message_ids') ELSE '[]' END,
       s.created_at,
       s.created_at
  FROM (SELECT substr(key, 14) AS work_id, created_at,
               CASE WHEN json_type(response_json) = 'object' THEN response_json ELSE '{}' END AS j
          FROM idempotency_keys
         WHERE substr(key, 1, 13) = 'owner-replan:') AS s
  JOIN works AS w ON w.id = s.work_id
 WHERE json_extract(s.j, '$.status') IN ('queued', 'attempted')
   AND json_type(s.j, '$.answer') = 'text';

DELETE FROM idempotency_keys
 WHERE substr(key, 1, 13) = 'owner-replan:';

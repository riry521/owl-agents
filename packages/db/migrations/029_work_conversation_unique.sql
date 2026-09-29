-- A Work has at most one active web conversation. Keep the newest active one
-- per Work and deactivate the rest before enforcing that with a unique index.
UPDATE conversations
   SET is_active = 0
 WHERE channel = 'web'
   AND work_id IS NOT NULL
   AND is_active = 1
   AND id <> (
     SELECT newest.id
       FROM conversations AS newest
      WHERE newest.channel = 'web'
        AND newest.work_id = conversations.work_id
        AND newest.is_active = 1
      ORDER BY newest.created_at DESC, newest.id DESC
      LIMIT 1
   );
CREATE UNIQUE INDEX conversations_one_active_web_per_work
  ON conversations (work_id)
  WHERE channel = 'web' AND work_id IS NOT NULL AND is_active = 1;

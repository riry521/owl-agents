-- Cancelling a Work now closes its open Decisions in the same transaction.
-- Decisions left open by earlier cancellations can no longer be acted on, so
-- close them the same way instead of keeping them answerable forever.
UPDATE decisions
   SET status = 'cancelled',
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       state_version = state_version + 1
 WHERE status = 'open'
   AND work_id IN (SELECT id FROM works WHERE state = 'cancelled');

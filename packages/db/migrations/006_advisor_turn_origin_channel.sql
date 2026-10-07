-- Persist the provider channel separately from the conversation thread ref.
-- Existing turns can recover their provider channel from the durable
-- conversation dm_ref. Only provider-matching Slack/Discord conversations are
-- used; rows without that evidence remain NULL and are never guessed.
-- New turns retain the exact channel needed by a fresh connector instance.
ALTER TABLE advisor_turns ADD COLUMN origin_channel_id TEXT NULL;

UPDATE advisor_turns
SET origin_channel_id = (
  SELECT conversations.dm_ref
    FROM conversations
   WHERE conversations.id = advisor_turns.conversation_id
     AND conversations.channel = advisor_turns.origin_channel
     AND conversations.dm_ref IS NOT NULL
     AND length(conversations.dm_ref) > 0
)
WHERE advisor_turns.origin_channel_id IS NULL
  AND advisor_turns.origin_channel IN ('slack', 'discord');

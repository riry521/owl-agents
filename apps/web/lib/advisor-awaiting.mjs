/**
 * Whether the reply to the message just sent has arrived: an advisor message
 * after it. Only this clears the awaiting state; a session reading idle does
 * not, because the turn is enqueued after the send returns and a cached
 * session can be stale in either direction.
 *
 * @param {{ messageId: string } | null} awaiting
 * @param {Array<{ id: string, source?: string }> | null} messages sorted by created_at
 */
export function replyArrived(awaiting, messages) {
  if (!awaiting || !messages) return false;
  const sentIndex = messages.findIndex((m) => m.id === awaiting.messageId);
  return sentIndex >= 0 && messages.slice(sentIndex + 1).some((m) => m.source === 'advisor');
}

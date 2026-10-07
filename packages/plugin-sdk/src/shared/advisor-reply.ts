import { connectorText } from "./connector-text";
import type { OwlLanguage } from "./language";

/**
 * Append a rendered "suggested next actions" section to an Advisor reply.
 *
 * `reply` is the text Core has already decided to show (Core is the sole
 * parsing point for any owl-actions fence); `value` is the event's
 * `suggested_actions` payload, an array of `{ type, description }` records
 * left unhandled by Core. Malformed or empty entries are silently skipped,
 * and the reply is returned unchanged when there is nothing to show.
 */
export function formatAdvisorReply(reply: string, value: unknown, language: OwlLanguage): string {
  if (!Array.isArray(value)) return reply;
  const actions = value.flatMap((candidate) => {
    const action = asRecord(candidate);
    const type = typeof action?.type === "string" ? action.type.trim() : "";
    const description = typeof action?.description === "string" ? action.description.trim() : "";
    return type.length > 0 && description.length > 0 ? [`• ${type}: ${description}`] : [];
  });
  return actions.length === 0 ? reply : `${reply}\n\n${connectorText(language).nextActions}\n${actions.join("\n")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

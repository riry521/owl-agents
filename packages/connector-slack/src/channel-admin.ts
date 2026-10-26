import type { WebClient } from "@slack/web-api";
import { ChannelAdminError, type ChannelAdmin, type ChannelAdminErrorCode, type ChannelInfo } from "@owl/plugin-sdk";

type SlackChannelApi = Pick<WebClient, "conversations">;

const INVALID_NAME_ERRORS: ReadonlySet<string> = new Set([
  "invalid_name", "invalid_name_specials", "invalid_name_punctuation", "invalid_name_maxlength", "invalid_name_required",
]);
const ERROR_CODES: ReadonlyMap<string, ChannelAdminErrorCode> = new Map([
  ["name_taken", "name_taken"],
  ["channel_not_found", "not_found"],
  ["not_in_channel", "bot_not_in_channel"],
  ["not_authorized", "not_authorized"],
  ["restricted_action", "not_authorized"],
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

/** Maps a WebClient failure to a ChannelAdminError; Slack's data.error string decides the code. */
export function toChannelAdminError(error: unknown): ChannelAdminError {
  const wrapper = record(error);
  const data = wrapper && Object.hasOwn(wrapper, "data") ? record(wrapper.data) : null;
  const slackError = data && typeof data.error === "string" ? data.error : "";
  if (slackError === "missing_scope") {
    const needed = typeof data?.needed === "string" ? data.needed.split(",").map((scope) => scope.trim()).filter(Boolean) : [];
    return new ChannelAdminError("permission_missing", `The Slack app lacks the ${needed.join(", ") || "required"} scope.`, { needed, provider_code: slackError });
  }
  if (wrapper && typeof wrapper.retryAfter === "number") {
    return new ChannelAdminError("rate_limited", "Slack rate-limited the request.", { retry_after_seconds: wrapper.retryAfter });
  }
  const code = INVALID_NAME_ERRORS.has(slackError) ? "invalid_name" : ERROR_CODES.get(slackError) ?? "provider_error";
  return new ChannelAdminError(code, `Slack returned ${slackError || "an error"}.`, { provider_code: slackError || undefined });
}

function toInfo(channel: unknown, fallbackMember: boolean): ChannelInfo {
  const value = record(channel);
  if (!value || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new ChannelAdminError("provider_error", "Slack returned a channel without id or name.");
  }
  return { channel_id: value.id, name: value.name, bot_is_member: typeof value.is_member === "boolean" ? value.is_member : fallbackMember };
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toChannelAdminError(error);
  }
}

export function createSlackChannelAdmin(web: SlackChannelApi): ChannelAdmin {
  return {
    createChannel: async (name) => toInfo((await call(() => web.conversations.create({ name, is_private: false }))).channel, true),
    renameChannel: async (channelId, name) => toInfo((await call(() => web.conversations.rename({ channel: channelId, name }))).channel, true),
    describeChannel: async (channelId) => toInfo((await call(() => web.conversations.info({ channel: channelId }))).channel, false),
    inviteUsers: async (channelId, userIds) => {
      await call(() => web.conversations.invite({ channel: channelId, users: userIds.join(",") }));
    },
  };
}

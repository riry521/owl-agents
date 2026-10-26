import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel } from "discord.js";
import { ChannelAdminError, isChannelAdminError, type ChannelAdmin, type ChannelAdminErrorCode, type ChannelInfo } from "@owl/plugin-sdk";

const MANAGE = "ManageChannels";
const MEMBER_PERMISSIONS: readonly [bigint, string][] = [
  [PermissionFlagsBits.ViewChannel, "ViewChannel"],
  [PermissionFlagsBits.SendMessages, "SendMessages"],
  [PermissionFlagsBits.ReadMessageHistory, "ReadMessageHistory"],
];
const ERROR_CODES: ReadonlyMap<number, ChannelAdminErrorCode> = new Map([
  [50001, "bot_not_in_channel"],
  [10003, "not_found"],
  [50035, "invalid_name"],
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

/** Maps a discord.js failure to a ChannelAdminError by DiscordAPIError code or HTTP 429. */
export function toChannelAdminError(error: unknown): ChannelAdminError {
  if (isChannelAdminError(error)) return error;
  const value = record(error);
  const code = value && Object.hasOwn(value, "code") ? value.code : undefined;
  if (code === 50013) return missingManage("50013");
  if (value?.status === 429 || value?.name === "RateLimitError") {
    const seconds = typeof value.timeToReset === "number" ? Math.ceil(value.timeToReset / 1000)
      : typeof value.retryAfter === "number" ? value.retryAfter : undefined;
    return new ChannelAdminError("rate_limited", "Discord rate-limited the request.", { retry_after_seconds: seconds });
  }
  const mapped = typeof code === "number" ? ERROR_CODES.get(code) : undefined;
  return new ChannelAdminError(mapped ?? "provider_error", `Discord returned ${code ?? "an error"}.`, { provider_code: code === undefined ? undefined : String(code) });
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toChannelAdminError(error);
  }
}

function missingManage(providerCode?: string): ChannelAdminError {
  return new ChannelAdminError("permission_missing", "The Discord bot lacks the Manage Channels permission.", { needed: [MANAGE], provider_code: providerCode });
}

function missingMemberPermissions(channel: GuildBasedChannel): string[] {
  const me = channel.guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  return MEMBER_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
}

function toInfo(channel: GuildBasedChannel): ChannelInfo {
  return { channel_id: channel.id, name: channel.name, bot_is_member: missingMemberPermissions(channel).length === 0 };
}

export function createDiscordChannelAdmin(client: Pick<Client, "channels">, conversationChannelIds: readonly string[]): ChannelAdmin {
  const guildChannel = async (channelId: string): Promise<GuildBasedChannel> => {
    // force: the cache would keep serving a stale name when a gateway update was missed.
    const channel = await call(() => client.channels.fetch(channelId, { force: true }));
    if (!channel) throw new ChannelAdminError("not_found", "The Discord channel does not exist.");
    if (channel.isDMBased()) throw new ChannelAdminError("not_found", "The Discord channel is not in a server.");
    return channel as GuildBasedChannel;
  };
  const guild = async (): Promise<Guild> => {
    const first = conversationChannelIds[0];
    const channel = first ? await client.channels.fetch(first).catch(() => null) : null;
    if (!channel || channel.isDMBased()) throw new ChannelAdminError("provider_error", "The Discord server could not be determined.", { provider_code: "guild_unknown" });
    return (channel as GuildBasedChannel).guild;
  };
  return {
    createChannel: async (name) => {
      const target = await guild();
      const me = target.members.me;
      if (!me || !me.permissions.has(PermissionFlagsBits.ManageChannels)) throw missingManage();
      return toInfo(await call(() => target.channels.create({ name, type: ChannelType.GuildText })));
    },
    renameChannel: async (channelId, name) => {
      const channel = await guildChannel(channelId);
      const me = channel.guild.members.me;
      if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) throw missingManage();
      return toInfo(await call(async () => (await channel.edit({ name })) as GuildBasedChannel));
    },
    describeChannel: async (channelId) => {
      const channel = await guildChannel(channelId);
      const needed = missingMemberPermissions(channel);
      if (needed.length > 0) throw new ChannelAdminError("bot_not_in_channel", "The Discord bot cannot view, send to or read the channel.", { needed });
      return toInfo(channel);
    },
    inviteUsers: async () => {
      throw new ChannelAdminError("provider_error", "Discord does not support inviting users to a channel.", { provider_code: "invite_unsupported" });
    },
  };
}

export interface ChannelInfo {
  readonly channel_id: string;
  readonly name: string;
  readonly bot_is_member: boolean;
}

export interface ChannelAdmin {
  createChannel(name: string): Promise<ChannelInfo>;
  renameChannel(channelId: string, name: string): Promise<ChannelInfo>;
  describeChannel(channelId: string): Promise<ChannelInfo>;
  inviteUsers(channelId: string, userIds: readonly string[]): Promise<void>;
}

export type ChannelAdminErrorCode =
  | "permission_missing" | "name_taken" | "invalid_name" | "not_found"
  | "bot_not_in_channel" | "not_authorized" | "rate_limited" | "provider_error";

export interface ChannelAdminErrorDetails {
  readonly needed?: readonly string[];
  readonly retry_after_seconds?: number;
  readonly provider_code?: string;
}

export class ChannelAdminError extends Error {
  readonly code: ChannelAdminErrorCode;
  readonly needed: readonly string[];
  readonly retry_after_seconds?: number;
  readonly provider_code?: string;

  constructor(code: ChannelAdminErrorCode, message: string, details: ChannelAdminErrorDetails = {}) {
    super(message);
    this.name = "ChannelAdminError";
    this.code = code;
    this.needed = details.needed ?? [];
    this.retry_after_seconds = details.retry_after_seconds;
    this.provider_code = details.provider_code;
  }
}

/** Matches by name and code: the connectors load a separate dist, so instanceof can disagree. */
export function isChannelAdminError(error: unknown): error is ChannelAdminError {
  return error instanceof Error && error.name === "ChannelAdminError" && typeof (error as { code?: unknown }).code === "string";
}

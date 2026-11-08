import type { AdvisorWindowSummary } from "../../../packages/shared/dist/advisor-windows.js";
import { ApiError } from "./errors.js";
import type { FileDestinationProvider, FileDestinationSettings } from "./app-settings-store.js";

export interface FileDestinationCandidate {
  channel_id: string;
  display_name: string;
  kind: "conversation" | "window";
  window_name?: string | null;
}

export interface FileDestinationProviderView {
  provider: FileDestinationProvider;
  configured: boolean;
  running: boolean;
  candidates: FileDestinationCandidate[];
}

export interface FileDestinationIntegration {
  provider: FileDestinationProvider;
  configured: boolean;
  running: boolean;
  conversationChannelIds: readonly string[];
}

/**
 * Candidates are the channels the Connectors accept Advisor replies for: conversation channels and window bindings.
 * Notification channels are left out on purpose. `names` maps `${provider}:${channel_id}` to a name Slack/Discord returned;
 * a missing entry falls back to the channel id.
 */
export function buildFileDestinationCandidates(
  integrations: readonly FileDestinationIntegration[],
  windows: readonly AdvisorWindowSummary[],
  names: ReadonlyMap<string, string>,
): FileDestinationProviderView[] {
  return integrations.map(({ provider, configured, running, conversationChannelIds }) => {
    const candidates: FileDestinationCandidate[] = [];
    const seen = new Set<string>();
    for (const id of conversationChannelIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ channel_id: id, display_name: names.get(`${provider}:${id}`) ?? id, kind: "conversation" });
    }
    for (const window of windows) {
      for (const channel of window.channels) {
        if (channel.provider !== provider || seen.has(channel.channel_id)) continue;
        seen.add(channel.channel_id);
        candidates.push({ channel_id: channel.channel_id, display_name: channel.display_name, kind: "window", window_name: window.name });
      }
    }
    return { provider, configured, running, candidates };
  });
}

const isProvider = (value: unknown): value is FileDestinationProvider => value === "slack" || value === "discord";
const hasExactKeys = (value: object, keys: readonly string[]): boolean => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates a PUT payload; display_name comes from the candidates, never from the client. */
export function parseFileDestinationPut(payload: unknown, providers: readonly FileDestinationProviderView[]): FileDestinationSettings {
  const invalid = (message: string, status = 400): ApiError => new ApiError(status, "validation_error", message);
  if (!isPlainObject(payload) || !hasExactKeys(payload, ["preferred_provider", "default_destination"])) {
    throw invalid("preferred_providerとdefault_destinationだけを指定してください。");
  }
  const { preferred_provider: preferred, default_destination: destination } = payload;
  if (preferred !== null && !isProvider(preferred)) throw invalid("preferred_providerはslack、discord、nullのどれかで指定してください。");
  if (destination === null) return { preferredProvider: preferred, defaultDestination: null };
  if (!isPlainObject(destination) || !hasExactKeys(destination, ["provider", "channel_id"])
    || !isProvider(destination.provider) || typeof destination.channel_id !== "string"
    || destination.channel_id.length < 1 || destination.channel_id.length > 200) {
    throw invalid("default_destinationはprovider(slackかdiscord)と1〜200文字のchannel_idで指定してください。");
  }
  const view = providers.find((entry) => entry.provider === destination.provider);
  const label = destination.provider === "slack" ? "Slack" : "Discord";
  if (!view?.configured) throw invalid(`${label} の連携が設定されていません。連携設定で Connector を設定してから選んでください。`, 422);
  const candidate = view.candidates.find((entry) => entry.channel_id === destination.channel_id);
  if (!candidate) throw invalid("このチャンネルは選べません。会話チャンネルか窓のチャンネルから選んでください。", 422);
  return {
    preferredProvider: preferred,
    defaultDestination: { provider: destination.provider, channel_id: candidate.channel_id, display_name: candidate.display_name },
  };
}

/** True when the saved default still passes step 3 of the destination rules. */
export function isDefaultAvailable(settings: FileDestinationSettings, providers: readonly FileDestinationProviderView[]): boolean {
  const saved = settings.defaultDestination;
  if (!saved) return false;
  const view = providers.find((entry) => entry.provider === saved.provider);
  return Boolean(view?.configured && view.candidates.some((entry) => entry.channel_id === saved.channel_id));
}

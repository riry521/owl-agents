/** Picks the Slack or Discord channel a Web conversation's send_file goes to. Pure: the caller gathers every input. */
export type FileDestinationProvider = "slack" | "discord";

export interface FileDestinationChannel {
  readonly provider: FileDestinationProvider;
  readonly channel_id: string;
  readonly display_name: string;
}

export interface FileDestinationProviderState {
  readonly provider: FileDestinationProvider;
  /** The integration has a Connector configured. */
  readonly configured: boolean;
  /** Conversation channels plus every window's bound channel of this provider. */
  readonly channel_ids: readonly string[];
}

export interface FileDestinationInput {
  readonly window_bindings: readonly FileDestinationChannel[];
  readonly preferred_provider: FileDestinationProvider | null;
  readonly default_destination: FileDestinationChannel | null;
  readonly providers: readonly FileDestinationProviderState[];
}

export type FileDestinationSource = "window_binding" | "default_destination";

export type FileDestinationRefusal =
  | "preferred_provider_unset"
  | "default_destination_unset"
  | "default_provider_not_configured"
  | "default_channel_unavailable";

export type FileDestinationResult =
  | { readonly kind: "resolved"; readonly destination: FileDestinationChannel & { readonly source: FileDestinationSource } }
  | { readonly kind: "refused"; readonly reason: FileDestinationRefusal };

export function resolveAdvisorFileDestination(input: FileDestinationInput): FileDestinationResult {
  const configured = new Set(input.providers.filter((state) => state.configured).map((state) => state.provider));
  const usable = input.window_bindings.filter((binding) => configured.has(binding.provider));
  const fromWindow = (binding: FileDestinationChannel): FileDestinationResult => ({
    kind: "resolved",
    destination: { provider: binding.provider, channel_id: binding.channel_id, display_name: binding.display_name, source: "window_binding" },
  });
  if (usable.length === 1) return fromWindow(usable[0]!);
  if (usable.length > 1) {
    const preferred = input.preferred_provider === null ? undefined : usable.find((binding) => binding.provider === input.preferred_provider);
    return preferred ? fromWindow(preferred) : { kind: "refused", reason: "preferred_provider_unset" };
  }
  const fallback = input.default_destination;
  if (fallback === null) return { kind: "refused", reason: "default_destination_unset" };
  const state = input.providers.find((candidate) => candidate.provider === fallback.provider);
  if (!state?.configured) return { kind: "refused", reason: "default_provider_not_configured" };
  if (!state.channel_ids.includes(fallback.channel_id)) return { kind: "refused", reason: "default_channel_unavailable" };
  return {
    kind: "resolved",
    destination: { provider: fallback.provider, channel_id: fallback.channel_id, display_name: fallback.display_name, source: "default_destination" },
  };
}

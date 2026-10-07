export type {
  OwlEvent,
  InboundMessage,
  InboundFile,
  PluginConfig,
  OwlPlugin,
} from "./types";
export { CoreClient, CoreRequestError, commandEnvelope, commandEnvelopeFor, newRequestId, type CorePage } from "./client";
export { formatIntegrationError } from "./error-display";
export { BasePlugin } from "./base-plugin";
export { runPluginFromEnv, type RunPluginOptions } from "./run";
export {
  classifyIntent,
  isStatusQuery,
  matchDecisionAnswer,
  type PendingDecision,
  type RoutedIntent,
  type RoutedMessage,
} from "./shared/router";
export { formatStatusResponse } from "./shared/status";
export { asOwlLanguage, type OwlLanguage } from "./shared/language";
export { connectorText, type ConnectorText } from "./shared/connector-text";
export {
  createDecisionButtonId,
  parseDecisionButtonId,
  resolveDecisionButtonTarget,
  type DecisionButtonTarget,
  type ResolvedDecisionButton,
} from "./shared/decision-button";
export {
  EXECUTABLE_EXTENSIONS,
  KNOWN_EXTENSIONS,
  uniqueName,
  type DownloadResult,
} from "./shared/files";

import type { OwlPlugin, PluginConfig } from "./types";
import { BasePlugin } from "./base-plugin";

export function createPlugin(
  name: string,
  config: PluginConfig,
  handlers: {
    onEvent?: (event: import("./types").OwlEvent) => Promise<void>;
    onInbound?: (message: import("./types").InboundMessage) => Promise<void>;
  },
): OwlPlugin {
  return new (class extends BasePlugin {
    readonly name = name;
    onEvent = handlers.onEvent;
    onInbound = handlers.onInbound;
  })(config);
}

import type { OwlEvent, InboundMessage, OwlPlugin, PluginConfig } from "./types";
import { commandEnvelope, CoreClient } from "./client";

export abstract class BasePlugin implements OwlPlugin {
  abstract readonly name: string;
  protected readonly client: CoreClient;
  protected readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
    this.client = new CoreClient(config);
  }

  async start(): Promise<void> {
    // Core has no work.failed event: Work failures surface as system.alert
    // (e.g. kind "workflow_tick_failed" with message/remediation) or as a
    // Decision. manager.failed is always followed by one of those.
    const eventTypes = this.config.subscribe_events ?? [
      "decision.opened",
      "work.completed",
      "work.cancelled",
      "system.alert",
    ];
    if (this.onEvent) {
      await this.client.subscribeEvents(eventTypes, (event) =>
        this.onEvent!(event).catch((err) => {
          console.error(`[${this.name}] onEvent error:`, err);
        })
      );
    }
    console.log(`[${this.name}] started`);
  }

  async stop(): Promise<void> {
    this.client.close();
    console.log(`[${this.name}] stopped`);
  }

  abstract onEvent?(event: OwlEvent): Promise<void>;
  abstract onInbound?(message: InboundMessage): Promise<void>;

  protected async postMessage(conversationId: string, body: string): Promise<void> {
    await this.client.request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: commandEnvelope({ body, attachment_ids: [] }, `${this.name}:message`),
    });
  }

  protected async answerDecision(decisionId: string, answer: string, optionKey: string | null, source: "web" | "slack" | "discord"): Promise<void> {
    await this.client.request(`/decisions/${encodeURIComponent(decisionId)}/answer`, {
      method: "POST",
      body: commandEnvelope({ answer, option_key: optionKey, source, source_message_id: null }, `${this.name}:decision`),
    });
  }

  protected async getStatus(): Promise<unknown> {
    return this.client.request("/system/status");
  }

  protected async listWorks(state?: string): Promise<unknown> {
    const params = state ? `?state=${state}` : "";
    return this.client.request(`/works${params}`);
  }
}

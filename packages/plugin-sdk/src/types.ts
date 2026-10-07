export interface OwlEvent {
  readonly event_id: string;
  readonly type: string;
  readonly sequence: number;
  readonly payload: Record<string, unknown>;
  readonly work_id?: string;
  readonly task_id?: string;
  readonly agent_run_id?: string;
  readonly created_at?: string;
}

export interface InboundMessage {
  readonly source: "slack" | "discord" | string;
  readonly user_id: string;
  readonly text: string;
  readonly files?: readonly InboundFile[];
  readonly thread_id?: string;
  readonly raw?: unknown;
}

export interface InboundFile {
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
}

export interface PluginConfig {
  readonly core_api_base: string;
  readonly core_ws_url?: string;
  readonly plugin_name: string;
  readonly subscribe_events?: readonly string[];
  /** Bearer service token used for REST and WebSocket authentication. */
  readonly api_token?: string;
  readonly owner_id?: string;
  readonly account_id?: string;
  /**
   * Where CoreClient persists its event cursor and Decision-to-notification
   * map. Omitted, the client keeps that state in memory only (it starts over
   * from the current cursor on every restart) — useful for tests and for any
   * caller that does not need it to survive a restart.
   */
  readonly state_store?: import("./shared/state-store").ConnectorStateStore;
}

export interface OwlPlugin {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent?(event: OwlEvent): Promise<void>;
  onInbound?(message: InboundMessage): Promise<void>;
}

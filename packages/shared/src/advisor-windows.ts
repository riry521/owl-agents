/** The window key that addresses the general Advisor window in URLs and API paths. Project windows use the Project id. */
export const GENERAL_WINDOW_KEY = "general";

export type AdvisorWindowScope = "general" | "project";

export type AdvisorWindowSessionStatus = "running" | "starting" | "suspended" | "none";

export interface AdvisorWindowChannel {
  readonly provider: "slack" | "discord";
  readonly channel_id: string;
  readonly display_name: string;
}

/** One entry of GET /advisor/windows. window_id and conversation_id are null until the window is first used. */
export interface AdvisorWindowSummary {
  readonly key: string;
  readonly scope: AdvisorWindowScope;
  readonly project_id: string | null;
  /** null for the general window; the UI shows its own label. */
  readonly name: string | null;
  readonly window_id: string | null;
  readonly conversation_id: string | null;
  readonly session_status: AdvisorWindowSessionStatus;
  readonly channels: readonly AdvisorWindowChannel[];
  readonly last_message_at: string | null;
}

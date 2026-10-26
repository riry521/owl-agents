import { createUlid, utcNow } from "../../db/dist/index.js";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

export type AdvisorSessionStatus = "starting" | "running" | "ending" | "ended" | "suspended";

export type AdvisorSessionEndReason =
  | "idle_timeout"
  | "owner_requested"
  | "crashed"
  | "core_restart"
  | "spawn_failed"
  | "resume_failed"
  | "cleared"
  | "model_changed";

export interface AdvisorSession {
  id: string;
  owner_id: string;
  conversation_id: string;
  /** The Advisor window this session belongs to; null for rows that predate windows. */
  window_id: string | null;
  status: AdvisorSessionStatus;
  end_reason: AdvisorSessionEndReason | null;
  pid: number | null;
  started_at: string | null;
  ended_at: string | null;
  last_activity_at: string;
  process_start_time: string | null;
  provider_id: string | null;
  harness_id: string | null;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  workspace_path: string | null;
  transcript_path: string | null;
  resumed_count: number;
  compaction_count: number;
  last_compaction_at: string | null;
  last_usage_json: string | null;
  system_prompt_sha256: string | null;
}

interface AdvisorSessionDbRow extends AdvisorSession {
  ending_started_at: string | null;
  session_summary_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The provider process is (supposed to be) alive. */
const LIVE_STATUSES = ["starting", "running", "ending"] as const;

/**
 * Statuses that occupy a window's single session slot; the same list as the
 * advisor_sessions_one_active_per_window partial index. 'suspended' is an idle
 * window that resumes from provider_session_id.
 */
const ACTIVE_STATUSES = [...LIVE_STATUSES, "suspended"] as const;

const END_REASONS: readonly AdvisorSessionEndReason[] = [
  "idle_timeout",
  "owner_requested",
  "crashed",
  "core_restart",
  "spawn_failed",
  "resume_failed",
  "cleared",
  "model_changed",
];

const SESSION_SELECT_COLUMNS = `
  session.id, conversation.owner_id, session.conversation_id, session.window_id,
  session.status, session.end_reason, session.pid,
  session.started_at, session.ended_at, session.last_activity_at,
  session.process_start_time,
  session.ending_started_at, session.session_summary_id,
  session.provider_id, session.harness_id, session.model, session.effort,
  session.provider_session_id, session.workspace_path, session.transcript_path,
  session.resumed_count, session.compaction_count, session.last_compaction_at,
  session.last_usage_json, session.system_prompt_sha256,
  session.created_at, session.updated_at
`;

/**
 * Persists the lifecycle of the single long-lived Advisor process.
 *
 * State changes are submitted through Core's WriteLane so a session mutation
 * and its canonical event are committed together. Lifecycle methods await the
 * WriteLane promise before returning, so callers never observe a session that
 * has only been queued in memory.
 */
export class AdvisorSessionManager {
  private readonly db: CoreDatabase;
  private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;

  public constructor(db: CoreDatabase) {
    this.db = db;
    this.writeLane = db.createWriteLane();
  }

  /** The general window's live session (windowless legacy rows count as general). */
  public getActiveSession(ownerId: string): AdvisorSession | null {
    const row = this.db.get<AdvisorSessionDbRow>(
      `SELECT ${SESSION_SELECT_COLUMNS}
         FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
         LEFT JOIN advisor_windows AS advisor_window ON advisor_window.id = session.window_id
        WHERE conversation.owner_id = ?
          AND (advisor_window.scope IS NULL OR advisor_window.scope = 'general')
          AND session.status IN (${placeholders(ACTIVE_STATUSES)})
        ORDER BY session.created_at DESC
        LIMIT 1`,
      ownerId,
    );
    return row ? toAdvisorSession(row) : null;
  }

  /** Every window's live or suspended session of the owner. */
  public listActiveSessions(ownerId: string): AdvisorSession[] {
    return this.db.all<AdvisorSessionDbRow>(
      `SELECT ${SESSION_SELECT_COLUMNS}
         FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
        WHERE conversation.owner_id = ? AND session.status IN (${placeholders(ACTIVE_STATUSES)})
        ORDER BY session.created_at ASC`,
      ownerId,
    ).map(toAdvisorSession);
  }

  public getActiveSessionForWindow(windowId: string): AdvisorSession | null {
    const row = this.db.get<AdvisorSessionDbRow>(
      `SELECT ${SESSION_SELECT_COLUMNS}
         FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
        WHERE session.window_id = ?
          AND session.status IN (${placeholders(ACTIVE_STATUSES)})
        LIMIT 1`,
      windowId,
    );
    return row ? toAdvisorSession(row) : null;
  }

  /**
   * Starts the window's session. windowId defaults to the window of
   * conversationId; at most one active session per window (the partial index
   * rejects a concurrent insert that slips past the checks).
   */
  public async startSession(ownerId: string, conversationId: string, windowId?: string | null, idleTimeoutSeconds?: number): Promise<AdvisorSession> {
    const resolvedWindowId = windowId !== undefined
      ? windowId
      : this.db.get<{ advisor_window_id: string | null }>("SELECT advisor_window_id FROM conversations WHERE id = ?", conversationId)?.advisor_window_id ?? null;
    if (resolvedWindowId ? this.getActiveSessionForWindow(resolvedWindowId) : this.getActiveSession(ownerId)) {
      throw new Error(`Owner ${ownerId} already has an active Advisor session.`);
    }

    const now = utcNow();
    const session: AdvisorSession = {
      id: createUlid(),
      owner_id: ownerId,
      conversation_id: conversationId,
      window_id: resolvedWindowId,
      status: "starting",
      end_reason: null,
      pid: null,
      started_at: now,
      ended_at: null,
      last_activity_at: now,
      process_start_time: null,
      provider_id: null,
      harness_id: null,
      model: null,
      effort: null,
      provider_session_id: null,
      workspace_path: null,
      transcript_path: null,
      resumed_count: 0,
      compaction_count: 0,
      last_compaction_at: null,
      last_usage_json: null,
      system_prompt_sha256: null,
    };

    await this.enqueueMutation("started", session.id, (transaction) => {
      const conversation = transaction.get<{ owner_id: string }>(
        `SELECT owner_id FROM conversations WHERE id = ?`,
        conversationId,
      );
      if (!conversation) {
        throw new Error(`Conversation ${conversationId} was not found.`);
      }
      if (conversation.owner_id !== ownerId) {
        throw new Error(`Conversation ${conversationId} does not belong to owner ${ownerId}.`);
      }

      const active = transaction.get<{ id: string }>(
        `SELECT id
           FROM advisor_sessions
          WHERE window_id IS ? AND status IN (${placeholders(ACTIVE_STATUSES)})
          LIMIT 1`,
        resolvedWindowId,
      );
      if (active) {
        throw new Error(`Owner ${ownerId} already has an active Advisor session.`);
      }

      transaction.run(
        `INSERT INTO advisor_sessions
           (id, status, pid, process_start_time, conversation_id, window_id,
            started_at, last_activity_at,
            ending_started_at, ended_at, end_reason, session_summary_id,
            created_at, updated_at, idle_timeout_seconds)
         VALUES (?, 'starting', NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, COALESCE(?, 7200))`,
        session.id,
        session.conversation_id,
        session.window_id,
        session.started_at,
        session.last_activity_at,
        now,
        now,
        idleTimeoutSeconds ?? null,
      );
      return session;
    });

    return session;
  }

  /**
   * Transition a starting session to running once the provider process has
   * actually spawned. `providerSessionId` (Claude session_id / Codex
   * thread_id) is optional so existing callers that only know the pid keep
   * compiling; the persistent-session runtime always supplies it.
   */
  public async activateSession(sessionId: string, pid: number, providerSessionId?: string): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new RangeError("Advisor session pid must be a positive integer.");
    }

    const now = utcNow();
    await this.enqueueMutation("activated", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET status = 'running',
                pid = ?,
                process_start_time = ?,
                started_at = ?,
                last_activity_at = ?,
                provider_session_id = COALESCE(NULLIF(?, ''), provider_session_id),
                updated_at = ?
          WHERE id = ? AND status = 'starting'`,
        pid,
        now,
        now,
        now,
        providerSessionId ?? null,
        now,
        sessionId,
      );
      return null;
    });
  }

  /** Running -> suspended: the provider process is gone, provider_session_id stays so the window can resume. */
  public async suspendSession(sessionId: string): Promise<void> {
    await this.changeState("suspended", sessionId, `UPDATE advisor_sessions SET status = 'suspended', pid = NULL, updated_at = ? WHERE id = ? AND status = 'running'`);
  }

  /** Suspended -> starting for a resume; activateSession then makes it running. */
  public async resumeSession(sessionId: string, idleTimeoutSeconds: number): Promise<void> {
    await this.changeState(
      "starting",
      sessionId,
      `UPDATE advisor_sessions SET status = 'starting', resumed_count = resumed_count + 1, idle_timeout_seconds = ?, last_activity_at = ?, updated_at = ?
        WHERE id = ? AND status = 'suspended'`,
      [idleTimeoutSeconds, utcNow()],
    );
  }

  /** Persist the provider-native session ID once the first stream turn emits its init frame. */
  public async setProviderSessionId(sessionId: string, providerSessionId: string): Promise<void> {
    const normalized = providerSessionId.trim();
    if (normalized.length === 0) return;
    const now = utcNow();
    await this.enqueueMutation("provider_session_ready", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET provider_session_id = CASE WHEN provider_session_id IS NULL OR provider_session_id = '' THEN ? ELSE provider_session_id END,
                updated_at = ?
          WHERE id = ? AND status IN (${placeholders(ACTIVE_STATUSES)})`,
        normalized,
        now,
        sessionId,
      );
      return null;
    });
  }

  public async recordActivity(sessionId: string): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("activity", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET last_activity_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('starting', 'running')`,
        now,
        now,
        sessionId,
      );
      return null;
    });
  }

  public async beginEnding(sessionId: string): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("ending", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET status = 'ending', ending_started_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('starting', 'running')`,
        now,
        now,
        sessionId,
      );
      return null;
    });
  }

  public async endSession(sessionId: string, reason: string): Promise<void> {
    if (!isAdvisorSessionEndReason(reason)) {
      throw new Error(`Invalid Advisor session end reason: ${reason}`);
    }

    const now = utcNow();
    await this.enqueueMutation("ended", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET status = 'ended', end_reason = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${placeholders(ACTIVE_STATUSES)})`,
        reason,
        now,
        now,
        sessionId,
      );
      return null;
    });
  }

  /**
   * Snapshot the provider/harness/model/effort a session was (or is being)
   * started with: settings are captured at session creation so later drift
   * can be detected per turn.
   */
  public async setProviderConfig(
    sessionId: string,
    config: { providerId: string; harnessId: string; model: string; effort?: string | null; systemPromptSha256?: string | null },
  ): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("provider_config", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET provider_id = ?, harness_id = ?, model = ?, effort = ?, system_prompt_sha256 = ?, updated_at = ?
          WHERE id = ?`,
        config.providerId,
        config.harnessId,
        config.model,
        config.effort ?? null,
        config.systemPromptSha256 ?? null,
        now,
        sessionId,
      );
      return null;
    });
  }

  /** Records the fixed workspace and (once known) transcript path for a session. */
  public async setWorkspace(sessionId: string, workspacePath: string, transcriptPath: string | null = null): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("workspace", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET workspace_path = ?, transcript_path = COALESCE(?, transcript_path), updated_at = ?
          WHERE id = ?`,
        workspacePath,
        transcriptPath,
        now,
        sessionId,
      );
      return null;
    });
  }

  /** Records the hash of the Owl system prompt the session currently follows. */
  public async setSystemPromptSha256(sessionId: string, systemPromptSha256: string): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("system_prompt", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions SET system_prompt_sha256 = ?, updated_at = ? WHERE id = ?`,
        systemPromptSha256,
        now,
        sessionId,
      );
      return null;
    });
  }

  /** Records the resolved transcript path once the driver has located it. */
  public async setTranscriptPath(sessionId: string, transcriptPath: string): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("transcript_path", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET transcript_path = ?, updated_at = ?
          WHERE id = ?`,
        transcriptPath,
        now,
        sessionId,
      );
      return null;
    });
  }

  /** Records the most recent turn's token usage for UI display. */
  public async recordUsage(sessionId: string, usageJson: string): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("usage", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET last_usage_json = ?, updated_at = ?
          WHERE id = ?`,
        usageJson,
        now,
        sessionId,
      );
      return null;
    });
  }

  /**
   * Records that a compaction was observed and (possibly) captured.
   * `compactionId` is the corresponding advisor_compactions.id; it becomes
   * the new session_summary_id, which points at the latest compaction row
   * instead of always being NULL.
   */
  public async recordCompaction(sessionId: string, compactionId: string): Promise<void> {
    const now = utcNow();
    await this.enqueueMutation("compaction", sessionId, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET session_summary_id = ?,
                compaction_count = compaction_count + 1,
                last_compaction_at = ?,
                updated_at = ?
          WHERE id = ?`,
        compactionId,
        now,
        now,
        sessionId,
      );
      return null;
    });
  }

  /**
   * On Core startup, any session still marked starting/running/ending
   * belongs to a process this Core instance no longer owns. Each is ended
   * with `core_restart`; a fresh session is started for the next turn.
   * 'suspended' rows have no process and stay, so they resume after a restart.
   */
  public async recoverOnStartup(): Promise<number> {
    const leftover = this.db.all<{ id: string }>(
      `SELECT id FROM advisor_sessions WHERE status IN (${placeholders(LIVE_STATUSES)})`,
    );
    if (leftover.length === 0) {
      return 0;
    }

    const now = utcNow();
    await this.enqueueMutation("recovered", null, (transaction) => {
      transaction.run(
        `UPDATE advisor_sessions
            SET status = 'ended', end_reason = 'core_restart', pid = NULL,
                ended_at = ?, updated_at = ?
          WHERE status IN (${placeholders(LIVE_STATUSES)})`,
        now,
        now,
      );
      return null;
    });
    return leftover.length;
  }

  /** Writes a suspend/resume transition together with the advisor.session_state_changed event the Web refreshes window state from. */
  private async changeState(status: "suspended" | "starting", sessionId: string, sql: string, leading: (string | number)[] = []): Promise<void> {
    const now = utcNow();
    const eventId = createUlid();
    const row = this.db.get<{ window_id: string | null; conversation_id: string }>(
      "SELECT window_id, conversation_id FROM advisor_sessions WHERE id = ?",
      sessionId,
    );
    await this.writeLane.write({
      mutateState: (transaction) => {
        transaction.run(sql, ...leading, now, sessionId);
        return null;
      },
      event: {
        id: eventId,
        idempotencyKey: `advisor-session:${status}:${eventId}`,
        type: "advisor.session_state_changed",
        payload: {
          kind: "advisor_session_state_changed",
          schema_version: "1.0.0",
          session_id: sessionId,
          window_id: row?.window_id ?? null,
          conversation_id: row?.conversation_id ?? null,
          status,
        },
      },
      outbox: [],
    });
  }

  private enqueueMutation<StateResult>(
    operation: string,
    sessionId: string | null,
    mutateState: (transaction: CoreWriteLaneTransaction) => StateResult,
  ): Promise<StateResult> {
    const eventId = createUlid();
    return this.writeLane.write({
      mutateState,
      event: {
        id: eventId,
        idempotencyKey: `advisor-session:${operation}:${eventId}`,
        type: "system.alert",
        payload: { operation, session_id: sessionId },
      },
      outbox: [],
    }).then((result) => result.state);
  }
}

function isAdvisorSessionEndReason(reason: string): reason is AdvisorSessionEndReason {
  return END_REASONS.includes(reason as AdvisorSessionEndReason);
}

function placeholders(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function toAdvisorSession(row: AdvisorSessionDbRow): AdvisorSession {
  return {
    id: row.id,
    owner_id: row.owner_id,
    conversation_id: row.conversation_id,
    window_id: row.window_id,
    status: row.status,
    end_reason: row.end_reason,
    pid: row.pid,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_activity_at: row.last_activity_at,
    process_start_time: row.process_start_time,
    provider_id: row.provider_id,
    harness_id: row.harness_id,
    model: row.model,
    effort: row.effort,
    provider_session_id: row.provider_session_id,
    workspace_path: row.workspace_path,
    transcript_path: row.transcript_path,
    resumed_count: row.resumed_count,
    compaction_count: row.compaction_count,
    last_compaction_at: row.last_compaction_at,
    last_usage_json: row.last_usage_json,
    system_prompt_sha256: row.system_prompt_sha256,
  };
}

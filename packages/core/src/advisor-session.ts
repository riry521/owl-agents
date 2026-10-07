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

/**
 * Statuses treated as "an owner already has a session" for the purposes of
 * getActiveSession/startSession. The 'suspended' status is only found in
 * rows written by older databases; such a row still blocks a new session
 * until recoverOnStartup ends it.
 */
const ACTIVE_STATUSES = ["starting", "running", "ending", "suspended"] as const;

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
  session.id, conversation.owner_id, session.conversation_id,
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

  public getActiveSession(ownerId: string): AdvisorSession | null {
    const row = this.db.get<AdvisorSessionDbRow>(
      `SELECT ${SESSION_SELECT_COLUMNS}
         FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
        WHERE conversation.owner_id = ?
          AND session.status IN (${placeholders(ACTIVE_STATUSES)})
        ORDER BY session.created_at DESC
        LIMIT 1`,
      ownerId,
    );
    return row ? toAdvisorSession(row) : null;
  }

  public async startSession(ownerId: string, conversationId: string): Promise<AdvisorSession> {
    if (this.getActiveSession(ownerId)) {
      throw new Error(`Owner ${ownerId} already has an active Advisor session.`);
    }

    const now = utcNow();
    const session: AdvisorSession = {
      id: createUlid(),
      owner_id: ownerId,
      conversation_id: conversationId,
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
          WHERE status IN (${placeholders(ACTIVE_STATUSES)})
          LIMIT 1`,
      );
      if (active) {
        throw new Error(`Owner ${ownerId} already has an active Advisor session.`);
      }

      transaction.run(
        `INSERT INTO advisor_sessions
           (id, status, pid, process_start_time, conversation_id,
            started_at, last_activity_at,
            ending_started_at, ended_at, end_reason, session_summary_id,
            created_at, updated_at)
         VALUES (?, 'starting', NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        session.id,
        session.conversation_id,
        session.started_at,
        session.last_activity_at,
        now,
        now,
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
   * On Core startup, any session still marked starting/running/ending (or
   * left 'suspended' by an older database) belongs to a process this Core
   * instance no longer owns. Each is ended with `core_restart`; a fresh
   * session is started for the next turn.
   */
  public async recoverOnStartup(): Promise<number> {
    const leftover = this.db.all<{ id: string }>(
      `SELECT id FROM advisor_sessions WHERE status IN (${placeholders(ACTIVE_STATUSES)})`,
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
          WHERE status IN (${placeholders(ACTIVE_STATUSES)})`,
        now,
        now,
      );
      return null;
    });
    return leftover.length;
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

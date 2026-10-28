// AdvisorSessionRuntime: core-side orchestrator that bridges
// AdvisorSessionManager (DB state, persistent-session contract) with a
// provider-neutral ProviderSession (child-process I/O, driven
// today by AdvisorSessionDriver, agent-runtime Phase 2). It owns the single
// long-lived Advisor session/process this Owl instance runs at a time (one
// owner-wide Advisor session shared by all interfaces), the FIFO turn queue
// backing it (advisor_turns), and compaction capture (advisor_compactions).
//

import { createHash } from "node:crypto";
import type { ProviderErrorRecord } from "@owl/shared";
import { insertProviderError } from "./provider-error-store";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { applyAdvisorInterfaceInstructions, externalJsonBlock, formatAdvisorMalformed, parseAdvisorResponse, parseSlackAdvisorResponse } from "@owl/shared";
import type { AdvisorSessionDirectory, AdvisorTurnRequest, AdvisorWorkspacePreparation, CoreDatabase, CoreWriteLaneTransaction, GitGateway } from "./types";
import type { AdvisorSession, AdvisorSessionManager } from "./advisor-session";
import type { MemorySaver } from "./memory-saver";
import { resolveAdvisorWorkingDirectory } from "./advisor-working-directory";
import { renderAdvisorWorkspaceNote } from "./advisor-workspace-note";
import { appendAdvisorProjectCatalog } from "./advisor-project-context";
import { appendAdvisorWorkCatalog } from "./advisor-work-context";
import { ADVISOR_TEXT, formatAdvisorRateLimitReply } from "./advisor-text";
import {
  buildFollowupTurnText, loadSourceActionResults, loadSourceFailures, nextTurnReceives, shouldInsertFollowup,
  type AdvisorActionFailure,
} from "./advisor-followup";
import { ADVISOR_FOLLOWUP_TURN_TEXT } from "@owl/shared";
import type { IndexInjector } from "./memory/index-injector.js";
import { searchQuery } from "./memory/memory-injector.js";
import { ownerLanguage, type OwnerLanguage } from "./owner-language";
import { advisorWindowSettings } from "./advisor-window-settings";
import { findAdvisorWindow } from "./advisor-windows";
import { GENERAL_WINDOW_KEY } from "../../shared/dist/advisor-windows.js";
import { CONVERSATION_COMPACT_INSTRUCTIONS } from "./memory/conversation-log.js";
import type { ConversationLogWriter } from "./memory/conversation-log-writer.js";
// Imported from the agent-runtime "types" submodule (not the package barrel
// "../../agent-runtime/dist/index.js") because that barrel re-exports
// core-contract.d.ts, which imports back from "../../core/dist/types.js" -
// pulling core's own dist output in as a compilation input and tripping
// TS5055 ("Cannot write file ... because it would overwrite input file").
import type {
  ProviderClient,
  ProviderSession,
  ProviderSessionRequest,
  SessionEvent,
  TokenUsage,
  AdvisorSuggestedAction,
  AdvisorMalformedHandler,
  RateLimitInfo,
  WebResearchCapture,
} from "@owl/shared";

/** provider_error.code of a turn.failed whose --resume found no conversation; mirrors RESUME_FAILED_CODE in agent-runtime, which core cannot import as a value. */
const RESUME_FAILED_CODE = "conversation_not_found";

/** Snapshot of the provider/harness/model/effort/system-prompt to (re)start an Advisor session with. */
export interface AdvisorSettingsSnapshot {
  readonly providerId: string;
  readonly harnessId: string;
  readonly model: string;
  readonly effort?: string;
  readonly systemPrompt: string;
  /** A custom provider's endpoint/key env, or {} for a built-in provider. */
  readonly connectionEnv?: Readonly<Record<string, string>>;
}

export interface AdvisorRuntimeConfig {
  readonly db: CoreDatabase;
  readonly sessionManager: AdvisorSessionManager;
  readonly memorySaver: MemorySaver;
  /** With `conversationLog` set a compaction summary becomes a conversation-log page instead of a legacy session note. */
  readonly conversationLog?: { readonly writer: Pick<ConversationLogWriter, "write"> };
  /** Harness ids whose compaction summary format can be set when the session starts (T10 design: none of the built-in ones). */
  readonly canInstructCompaction?: (harnessId: string) => boolean;
  readonly providerClient: ProviderClient;
  readonly owlRoot: string;
  readonly git?: GitGateway;
  readonly getAdvisorSettings: () => AdvisorSettingsSnapshot;
  /** Memory catalog for each turn (design §6): the first call of a session is the start catalog, later calls only the new items. */
  readonly memoryInjector?: Pick<IndexInjector, "compose" | "resetSession">;
  readonly isProviderPaused?: (provider: string) => boolean;
  readonly onProviderRateLimited?: (provider: string, rateLimit: RateLimitInfo) => Promise<{ readonly resume_at: string | null }>;
  readonly onProviderSucceeded?: (provider: string, runStartedAt: string) => Promise<void>;
  /** Advisor WebFetch / WebSearch results; recording failures never affect the turn. */
  readonly onWebResearch?: (
    capture: WebResearchCapture,
    context: { readonly conversation_id: string; readonly turn_id: string },
  ) => void;
  /** The driver could not read a web research result, so nothing was recorded for it. */
  readonly onWebResearchFailed?: (
    error: string,
    context: { readonly conversation_id: string; readonly turn_id: string },
  ) => void;
  /**
   * Resolves a user message's attachment_ids to absolute file paths (plus
   * any owner-language notes, e.g. for a quarantined attachment). Used to
   * populate a turn's attachment_paths both when freshly enqueued and when
   * rebuilt from the DB after a restart (loadTurnRequest has no in-memory
   * cache in that case).
   */
  readonly resolveAttachmentPaths: (messageId: string) => { paths: readonly string[]; notes: readonly string[] };
  /** Text block of the status answers a turn's message carries, rebuilt after a restart. */
  readonly resolveStatusExchangesBlock?: (messageId: string) => string | null;
  /** Text block of the window handoffs a turn's message carries, rebuilt after a restart. */
  readonly resolveWindowHandoffBlock?: (messageId: string) => string | null;
  readonly onReply: (
    conversationId: string,
    reply: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
    suggestedActions: readonly AdvisorSuggestedAction[],
    actionsMalformed?: boolean,
  ) => Promise<string | null>;
  readonly onError: (
    conversationId: string,
    errorMessage: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
  ) => Promise<void>;
}

type AdvisorTurnStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

interface AdvisorTurnRow {
  id: string;
  session_id: string;
  conversation_id: string;
  user_message_id: string;
  reply_message_id: string | null;
  status: AdvisorTurnStatus;
  origin_channel: string;
  origin_channel_id: string | null;
  origin_ref: string | null;
  retry_count: number;
  followup_of_turn_id: string | null;
  usage_json: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const MAX_TURN_RETRIES = 1;

const OWL_INSTRUCTIONS_UPDATE_HEADER =
  "[Owl] Your Owl instructions were updated. From now on, follow the instructions below instead of the system instructions you started with.";

function providerAliases(provider: string): string[] {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") return ["anthropic", "claude"];
  if (normalized === "openai" || normalized === "codex" || normalized === "openai/codex") return ["openai", "codex", "openai/codex"];
  if (normalized === "opencode") return ["opencode"];
  return [provider];
}

/** Shown instead of a blank message when the Advisor turn produced no text. */
export const EMPTY_ADVISOR_REPLY_NOTICE = ADVISOR_TEXT.ja.emptyReply;

function rateLimitInfoFromEvent(event: SessionEvent): RateLimitInfo | null {
  const info = (event as SessionEvent & { readonly rate_limit?: RateLimitInfo | null }).rate_limit;
  if (!info || typeof info !== "object" || !Object.hasOwn(info, "resets_at")) return null;
  const resetsAt = typeof info.resets_at === "string" && Number.isFinite(Date.parse(info.resets_at))
    ? new Date(info.resets_at).toISOString()
    : null;
  const source = info.source === "event" || info.source === "text" || info.source === "retry_after"
    ? info.source
    : null;
  return { resets_at: resetsAt, source };
}

/**
 * Parse a completed Advisor turn for any channel without ever failing the
 * turn: the strict parser is tried first, and when it rejects the text (empty
 * reply, a reply that starts with "{" but is not the legacy envelope, a bad
 * suggested_actions list, ...) the fail-open parser keeps the raw visible
 * text and hides only malformed owl-actions blocks. A reply with neither
 * visible text nor actions becomes an explicit notice instead of a blank
 * message.
 */
export function parseAdvisorTurnReply(
  originChannel: string,
  rawReply: string,
  language: OwnerLanguage = "ja",
): { readonly reply: string; readonly suggested_actions: readonly AdvisorSuggestedAction[]; readonly malformed?: true } {
  let malformed = false;
  const onMalformedActions: AdvisorMalformedHandler = (reason, detail) => {
    malformed = true;
    console.warn(`[owl-core] Ignoring malformed Advisor owl-actions block (${formatAdvisorMalformed(reason, detail)}); keeping reply text.`);
  };
  let parsed: { readonly reply: string; readonly suggested_actions: readonly AdvisorSuggestedAction[] };
  if (originChannel.trim().toLowerCase() === "slack") {
    parsed = parseSlackAdvisorResponse(rawReply, onMalformedActions);
  } else {
    try {
      parsed = parseAdvisorResponse(rawReply, onMalformedActions);
    } catch (error) {
      console.warn(
        `[owl-core] Advisor reply did not match the response format (${error instanceof Error ? error.message : String(error)}); keeping reply text.`,
      );
      parsed = parseSlackAdvisorResponse(rawReply, onMalformedActions);
    }
  }
  if (parsed.reply.trim().length === 0 && parsed.suggested_actions.length === 0) {
    return { reply: ADVISOR_TEXT[language].emptyReply, suggested_actions: [], ...(malformed ? { malformed } : {}) };
  }
  return malformed ? { ...parsed, malformed } : parsed;
}

/** No live Advisor session has the requested id. */
export class AdvisorSessionNotFoundError extends Error {
  public constructor(sessionId: string) {
    super(`Advisor session ${sessionId} was not found.`);
    this.name = "AdvisorSessionNotFoundError";
  }
}

class AdvisorRuntimeStoppedError extends Error {
  public constructor() {
    super("The Advisor runtime is shutting down.");
  }
}

/** The Advisor window a conversation belongs to; window_id is null for conversations that predate windows. */
interface WindowTarget {
  readonly window_id: string | null;
  /** The conversation the turn arrived on; a session started for it uses its working directory. */
  readonly conversation_id: string;
}

/** Everything one Advisor window owns while its session is running; windows never share any of it. */
interface WindowSlot {
  driver: ProviderSession | null;
  sessionId: string | null;
  /** The Owl system prompt the live session currently follows (its start prompt, or the latest update sent to it). */
  systemPrompt: string | null;
  /** The conversation and origin of the most recent turn sent to the live session; unsolicited replies are posted there. */
  lastTurnTarget: { readonly sessionId: string; readonly conversationId: string; readonly origin: AdvisorTurnRequest["origin"] } | null;
  /** Serializes handling of unsolicited replies so they are posted in arrival order. */
  unsolicitedChain: Promise<void>;
  turnLoopRunning: boolean;
  /** Set when startTurnLoop is called while the loop is already running; the loop switches to this session once its current queue drains. */
  turnLoopKick: string | null;
  /** Serializes ensureSession/suspend/stop for this window so two callers never race to create two provider processes for it. */
  lock: Promise<void>;
  /** Recent window history, put before the next turn's text once, when a suspended session could not be resumed. */
  pendingHistoryBlock: string | null;
  /** The session resumed from suspension whose first turn has not settled yet; if it dies first, the resume counts as failed. */
  unconfirmedResume: string | null;
}

/** Slot key for conversations that predate windows. */
const LEGACY_WINDOW_KEY = "legacy";

/**
 * Orchestrates the persistent Advisor ProviderSessions, one per window (the
 * general window and each Project window): (re)creating, resuming and
 * suspending them via AdvisorSessionManager + ProviderClient.createSession,
 * running a FIFO queue of turns against each (advisor_turns), and reacting to
 * the SessionEvent stream (turn completion/failure, compaction, process exit).
 *
 * Windows run side by side, each with its own WindowSlot; the turns of one
 * window run one after another. AdvisorSessionManager's "one active session
 * per window" guard backs the slot.
 */
export class AdvisorSessionRuntime {
  private readonly config: AdvisorRuntimeConfig;
  private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  private readonly pendingTurnPayloads = new Map<string, AdvisorTurnRequest>();
  private readonly slots = new Map<string, WindowSlot>();
  /** Sessions whose provider process is being started and is not yet a slot's driver. */
  private readonly startingSessionIds = new Set<string>();
  /** Keyed by conversation and shared worktree path, so one dirty worktree is announced once however many targets point at it. */
  private readonly workspaceWasDirty = new Map<string, boolean>();
  private readonly sessionDirectories = new Map<string, AdvisorSessionDirectory>();
  /** Project ids (null = the session's default target) whose shared worktree this session prepared, so replies keep checking them. */
  private readonly preparedTargets = new Map<string, Set<string | null>>();
  private stopped = false;
  /** Serializes workspace sweeps with the creation of a session's working directory, across windows. */
  private directoryLock: Promise<void> = Promise.resolve();

  public constructor(config: AdvisorRuntimeConfig) {
    this.config = config;
    this.writeLane = config.db.createWriteLane();
  }

  private slotFor(key: string | null): WindowSlot {
    const slotKey = key ?? LEGACY_WINDOW_KEY;
    let slot = this.slots.get(slotKey);
    if (!slot) {
      slot = {
        driver: null, sessionId: null, systemPrompt: null, lastTurnTarget: null,
        unsolicitedChain: Promise.resolve(), turnLoopRunning: false, turnLoopKick: null,
        lock: Promise.resolve(), pendingHistoryBlock: null, unconfirmedResume: null,
      };
      this.slots.set(slotKey, slot);
    }
    return slot;
  }

  /** The slot a session runs in: the one holding it, else the one of the window recorded on its row. */
  private slotForSession(sessionId: string): WindowSlot {
    for (const slot of this.slots.values()) if (slot.sessionId === sessionId) return slot;
    const row = this.config.db.get<{ window_id: string | null }>("SELECT window_id FROM advisor_sessions WHERE id = ?", sessionId);
    return this.slotFor(row?.window_id ?? null);
  }

  /** Chains `fn` after every call already queued on `lock`; a rejection never blocks callers queued behind it. */
  private chain<T>(holder: { lock: Promise<void> }, fn: () => Promise<T>): Promise<T> {
    const run = holder.lock.then(fn, fn);
    holder.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private withDirectoryLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.directoryLock.then(fn, fn);
    this.directoryLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A conversation with no window (it predates windows) belongs to its Owner's general window; Work conversations have none. */
  private windowOf(conversationId: string): WindowTarget {
    const row = this.config.db.get<{ advisor_window_id: string | null; owner_id: string; work_id: string | null }>(
      "SELECT advisor_window_id, owner_id, work_id FROM conversations WHERE id = ?",
      conversationId,
    );
    if (row && row.advisor_window_id === null && row.work_id === null) {
      const general = findAdvisorWindow(this.config.db, row.owner_id, GENERAL_WINDOW_KEY);
      if (general) return general;
    }
    return { window_id: row?.advisor_window_id ?? null, conversation_id: conversationId };
  }

  /** Runs `fn` inside the lock of the window that owns `conversationId`. */
  private inWindow<T>(conversationId: string, fn: (slot: WindowSlot, window: WindowTarget) => Promise<T>): Promise<T> {
    const window = this.windowOf(conversationId);
    const slot = this.slotFor(window.window_id);
    return this.chain(slot, () => fn(slot, window));
  }

  private activeSessionOf(ownerId: string, window: WindowTarget): AdvisorSession | null {
    return window.window_id === null
      ? this.config.sessionManager.getActiveSession(ownerId)
      : this.config.sessionManager.getActiveSessionForWindow(window.window_id);
  }

  /**
   * Returns the window's Advisor session to send the next turn against,
   * (re)creating the provider process as needed:
   *   - an already-running session whose driver this runtime still holds,
   *     and whose model/effort match current settings, is reused as-is,
   *     regardless of which interface conversation supplied the turn or
   *     whether the Owl system prompt changed (an updated prompt is sent to
   *     the live session with its next turn);
   *   - a suspended session is resumed from its provider_session_id;
   *   - anything else unreusable (model or effort drift, a DB-active session
   *     this process holds no live driver for, or a held driver whose
   *     process already exited while idle) is ended and replaced by a fresh
   *     session.
   */
  public ensureSession(ownerId: string, conversationId: string): Promise<AdvisorSession> {
    return this.inWindow(conversationId, (slot, window) => this.ensureSessionUnlocked(slot, window, ownerId));
  }

  /**
   * ensureSession followed by enqueueTurn as one step under the window's lock,
   * so a concurrent settings change cannot replace the session between the two
   * and leave the turn on an ended session.
   */
  public ensureSessionAndEnqueue(
    ownerId: string,
    conversationId: string,
    userMessageId: string,
    turn: AdvisorTurnRequest,
  ): Promise<{ session: AdvisorSession; turnId: string }> {
    return this.inWindow(conversationId, async (slot, window) => {
      const session = await this.ensureSessionUnlocked(slot, window, ownerId);
      const turnId = await this.enqueueTurn(session.id, conversationId, userMessageId, turn);
      return { session, turnId };
    });
  }

  /**
   * Brings the window's Advisor session up, or onto changed settings, without
   * a turn to send. A no-op while the runtime is stopped, the Advisor provider
   * is paused, the window is suspended (only a message wakes it), or a turn
   * loop is draining on a live process (its in-flight turn is never
   * interrupted; the next call applies any pending change).
   */
  public ensureResident(ownerId: string, conversationId: string): Promise<void> {
    return this.inWindow(conversationId, async (slot, window) => {
      if (this.stopped) return;
      if (this.activeSessionOf(ownerId, window)?.status === "suspended") return;
      if (slot.turnLoopRunning && slot.driver !== null && slot.driver.exited !== true) return;
      const settings = this.config.getAdvisorSettings();
      if (this.config.isProviderPaused?.(settings.providerId)) return;
      await this.ensureSessionUnlocked(slot, window, ownerId);
    });
  }

  private async ensureSessionUnlocked(slot: WindowSlot, window: WindowTarget, ownerId: string): Promise<AdvisorSession> {
    const settings = this.config.getAdvisorSettings();
    const active = this.activeSessionOf(ownerId, window);

    if (active === null) {
      const created = await this.createSession(slot, ownerId, window.conversation_id, settings);
      await this.adoptQueuedTurns(created.id);
      return created;
    }

    const modelDrifted =
      active.provider_id !== null &&
      active.model !== null &&
      (active.provider_id !== settings.providerId || active.model !== settings.model);
    const effortDrifted = active.effort !== (settings.effort ?? null);
    if (
      !modelDrifted &&
      !effortDrifted &&
      active.status === "running" &&
      slot.driver !== null &&
      slot.driver.exited !== true &&
      slot.sessionId === active.id
    ) {
      return active;
    }

    if (active.status === "suspended" && !modelDrifted && !effortDrifted) {
      const resumed = await this.resumeSuspended(slot, window, ownerId, active, settings);
      if (resumed) {
        await this.adoptQueuedTurns(resumed.id);
        return resumed;
      }
    } else {
      // Model or effort changed, or the DB says starting/running/ending/suspended but this
      // process holds no live driver for it (a driver that exited while idle;
      // its session.exited is only consumed while a turn is in flight). None is
      // reusable: stop what remains (stop() on an exited driver returns once
      // its process is gone) and start fresh.
      const resumeUnconfirmed = slot.unconfirmedResume === active.id;
      const reason = modelDrifted ? "model_changed" : effortDrifted ? "owner_requested" : resumeUnconfirmed ? "resume_failed" : "crashed";
      if (reason === "crashed" && slot.sessionId === active.id) {
        const detail = slot.driver?.exit_detail;
        if (detail) console.error(`[owl-core] Advisor session ${active.id} is no longer usable: ${detail}`);
      }
      // A fresh session knows nothing of the suspended or just-resumed one's talk, so it is handed the window's history.
      if (active.status === "suspended" || resumeUnconfirmed) slot.pendingHistoryBlock = this.buildHistoryBlock(window);
      slot.unconfirmedResume = null;
      await this.stopSession(active.id, reason);
    }
    const replacement = await this.createSession(slot, ownerId, window.conversation_id, settings);
    await this.adoptQueuedTurns(replacement.id);
    return replacement;
  }

  /**
   * Continues a suspended session from its provider_session_id. A failed
   * resume ends the session with resume_failed and returns null, so the caller
   * starts a fresh one that is handed the recent window history.
   */
  private async resumeSuspended(
    slot: WindowSlot,
    window: WindowTarget,
    ownerId: string,
    active: AdvisorSession,
    settings: AdvisorSettingsSnapshot,
  ): Promise<AdvisorSession | null> {
    try {
      if (!active.provider_session_id) throw new Error("The suspended Advisor session has no provider session id to resume.");
      // Claude writes its transcript at the first user input, so an id Owl only chose with --session-id has nothing to resume until a turn has completed.
      const answered = this.config.db.get<{ n: number }>(`SELECT 1 AS n FROM advisor_turns WHERE session_id = ? AND status = 'completed' LIMIT 1`, active.id);
      if (!answered) throw new Error("The suspended Advisor session never completed a turn, so its provider session id has no transcript to resume.");
      this.requireSessionSupport();
      const directory = await this.withDirectoryLock(async () => {
        const built = await this.buildWorkingDirectory(active.conversation_id);
        await this.config.sessionManager.resumeSession(active.id, advisorWindowSettings(this.config.db).idle_timeout_seconds);
        return built;
      });
      this.startingSessionIds.add(active.id);
      try {
        const resumed = await this.launchSession(slot, { ...active, status: "starting" }, settings, directory, active.provider_session_id);
        slot.unconfirmedResume = active.id;
        return { ...resumed, resumed_count: active.resumed_count + 1 };
      } finally {
        this.startingSessionIds.delete(active.id);
      }
    } catch (error) {
      if (error instanceof AdvisorRuntimeStoppedError) throw error;
      console.warn(`[owl-core] Could not resume Advisor session ${active.id}; starting a new one with the window history`, error);
      slot.pendingHistoryBlock = this.buildHistoryBlock(window);
      await this.config.sessionManager.endSession(active.id, "resume_failed");
      return null;
    }
  }

  /** The last history_handoff_messages messages of the window's conversations (Owner and Advisor alike), oldest first. */
  private buildHistoryBlock(window: WindowTarget): string | null {
    const limit = advisorWindowSettings(this.config.db).history_handoff_messages;
    if (limit <= 0) return null;
    const rows = this.config.db.all<{ source_message_id: string; body: string; received_at: string }>(
      `SELECT m.source_message_id, m.body, m.received_at
         FROM messages AS m JOIN conversations AS c ON c.id = m.conversation_id
        WHERE c.archived_at IS NULL AND ${window.window_id === null ? "c.id = ?" : "c.advisor_window_id = ?"}
        ORDER BY m.received_at DESC, m.id DESC LIMIT ?`,
      window.window_id ?? window.conversation_id,
      limit,
    );
    if (rows.length === 0) return null;
    return externalJsonBlock(
      "owl-window-history",
      rows.reverse().map((row) => ({ from: row.source_message_id.startsWith("advisor:") ? "advisor" : "owner", body: row.body, at: row.received_at })),
    );
  }

  /** Puts the pending window history, once, in front of a turn's text. */
  private takeHistoryBlock(slot: WindowSlot, text: string): string {
    const block = slot.pendingHistoryBlock;
    slot.pendingHistoryBlock = null;
    return block ? `${block}\n\n${text}` : text;
  }

  /**
   * Suspends every window whose running session has had no activity for its
   * idle_timeout_seconds and has no queued or running turn. Its provider
   * process is stopped; provider_session_id stays so the next message resumes it.
   */
  public async suspendIdleWindows(): Promise<void> {
    for (const slot of [...this.slots.values()]) {
      await this.chain(slot, () => this.suspendIfIdle(slot)).catch((error: unknown) =>
        console.error("[owl-core] Could not suspend an idle Advisor window", error));
    }
  }

  private async suspendIfIdle(slot: WindowSlot): Promise<void> {
    const sessionId = slot.sessionId;
    const driver = slot.driver;
    if (this.stopped || sessionId === null || driver === null || slot.turnLoopRunning) return;
    const session = this.config.db.get<{ status: string; last_activity_at: string; idle_timeout_seconds: number }>(
      "SELECT status, last_activity_at, idle_timeout_seconds FROM advisor_sessions WHERE id = ?",
      sessionId,
    );
    if (!session || session.status !== "running") return;
    if (Date.now() - Date.parse(session.last_activity_at) < session.idle_timeout_seconds * 1000) return;
    if (this.config.db.get("SELECT 1 FROM advisor_turns WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1", sessionId)) return;
    slot.driver = null;
    slot.sessionId = null;
    slot.systemPrompt = null;
    await driver.stop("idle_timeout");
    await this.config.sessionManager.suspendSession(sessionId);
  }

  /**
   * Queues a turn for a session and returns its advisor_turns row id
   * immediately. The row is persisted asynchronously via the WriteLane; the
   * turn loop is only kicked once that write has actually committed, so the
   * loop's first dequeue is guaranteed to see it.
   */
  public async enqueueTurn(
    sessionId: string,
    conversationId: string,
    userMessageId: string,
    turn: AdvisorTurnRequest,
  ): Promise<string> {
    const id = createUlid();
    const now = utcNow();
    // The provider's turn events are matched against advisor_turns.id in
    // consumeUntilTurnSettles(), so use the persisted row ID as the provider
    // correlation ID as well.
    this.pendingTurnPayloads.set(id, { ...turn, turn_id: id });

    const writeDone = this.enqueueTurnMutation("enqueued", { turn_id: id, session_id: sessionId }, (transaction) => {
      transaction.run(
        `INSERT INTO advisor_turns
           (id, session_id, conversation_id, user_message_id, status, origin_channel, origin_channel_id, origin_ref, queued_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        id,
        sessionId,
        conversationId,
        userMessageId,
        turn.origin.channel,
        turn.origin.channel_id ?? null,
        turn.origin.ref ?? null,
        now,
      );
    });
    await writeDone;
    void this.startTurnLoop(sessionId).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${sessionId}`, error));
    return id;
  }

  /**
   * The session a reply of `sourceTurnId` gets a follow-up turn on (6.2), or null when none should be queued.
   * A spontaneous reply has no turn row, so the conversation's latest turn names the session.
   */
  public followupSessionFor(input: { sourceTurnId: string; conversationId: string; failures: readonly AdvisorActionFailure[] }): string | null {
    const db = this.config.db;
    const source = db.get<{ session_id: string; followup_of_turn_id: string | null }>(
      "SELECT session_id, followup_of_turn_id FROM advisor_turns WHERE id = ?", input.sourceTurnId,
    );
    const sessionId = source?.session_id ?? db.get<{ session_id: string }>(
      "SELECT session_id FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1", input.conversationId,
    )?.session_id ?? null;
    const insert = shouldInsertFollowup({
      failures: input.failures,
      sourceIsFollowup: (source?.followup_of_turn_id ?? null) !== null,
      followupExists: db.get("SELECT 1 FROM advisor_turns WHERE followup_of_turn_id = ?", input.sourceTurnId) !== undefined,
      nextTurnReceives: nextTurnReceives(db, input.sourceTurnId, MAX_TURN_RETRIES),
      sessionFound: sessionId !== null,
    });
    return insert ? sessionId : null;
  }

  /** Called inside the reply's write transaction; returns the new turn and its session, or null when none was queued. */
  public insertFollowupTurn(
    transaction: CoreWriteLaneTransaction,
    input: { sourceTurnId: string; conversationId: string; replyMessageId: string; origin: AdvisorTurnRequest["origin"]; failures: readonly AdvisorActionFailure[] },
  ): { turnId: string; sessionId: string } | null {
    const sessionId = this.followupSessionFor(input);
    if (sessionId === null) return null;
    const turnId = createUlid();
    const inserted = transaction.run(
      `INSERT OR IGNORE INTO advisor_turns
         (id, session_id, conversation_id, user_message_id, status, origin_channel, origin_channel_id, origin_ref, queued_at, followup_of_turn_id)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      turnId, sessionId, input.conversationId, input.replyMessageId,
      input.origin.channel, input.origin.channel_id ?? null, input.origin.ref ?? null, utcNow(), input.sourceTurnId,
    );
    return inserted.changes > 0 ? { turnId, sessionId } : null;
  }

  /** After the write has committed: wakes the turn loop for the session the follow-up was queued on. */
  public kickFollowupTurn(sessionId: string): void {
    void this.startTurnLoop(sessionId).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${sessionId}`, error));
  }

  /** Whether this runtime holds a running driver for the session, or is still starting one. */
  public isSessionLive(sessionId: string): boolean {
    if (this.startingSessionIds.has(sessionId)) return true;
    for (const slot of this.slots.values()) {
      if (slot.sessionId === sessionId && slot.driver !== null && slot.driver.exited !== true) return true;
    }
    return false;
  }

  /**
   * Stops the driver for `sessionId` (if this runtime currently holds it)
   * and ends the logical session with `reason`.
   * The conversation-scoped workspace is independent and is never removed
   * here; pending changes are reported before an ended session is forgotten.
   */
  public async stopSession(sessionId: string, reason: string): Promise<void> {
    const slot = [...this.slots.values()].find((candidate) => candidate.sessionId === sessionId);
    if (slot && slot.driver !== null) {
      const driver = slot.driver;
      this.forgetDriver(slot);
      await driver.stop(reason);
    }
    await this.config.sessionManager.endSession(sessionId, reason);
    await this.notifyRetainedWorkspace(sessionId);
  }

  private forgetDriver(slot: WindowSlot): void {
    slot.driver = null;
    slot.sessionId = null;
    slot.systemPrompt = null;
  }

  /**
   * Recovery pass for Core startup: any turn left "running" belongs to a
   * process this Core instance no longer owns, mirroring
   * AdvisorSessionManager.recoverOnStartup for sessions. Interrupted turns
   * that have not yet been retried are requeued once; turns already retried
   * are left "interrupted" for a human/Librarian to notice rather than
   * retried forever.
   */
  public async recoverTurns(): Promise<void> {
    await this.enqueueTurnMutation("interrupted", {}, (transaction) => {
      transaction.run(`UPDATE advisor_turns SET status = 'interrupted' WHERE status = 'running'`);
    });
    const interrupted = this.config.db.all<AdvisorTurnRow>(
      `SELECT * FROM advisor_turns WHERE status = 'interrupted' AND retry_count < ?`,
      MAX_TURN_RETRIES,
    );
    for (const turn of interrupted) {
      const conversation = this.config.db.get<{ owner_id: string }>(
        `SELECT owner_id FROM conversations WHERE id = ?`,
        turn.conversation_id,
      );
      if (!conversation) {
        await this.failTurn(turn, `Advisor turn ${turn.id} references a missing conversation.`);
        continue;
      }

      let sessionId: string;
      try {
        sessionId = await this.inWindow(turn.conversation_id, async (slot, window) => {
          const session = await this.ensureSessionUnlocked(slot, window, conversation.owner_id);
          await this.enqueueTurnMutation("requeued", { turn_id: turn.id }, (transaction) => {
            transaction.run(
              `UPDATE advisor_turns
                  SET session_id = ?, status = 'queued', retry_count = retry_count + 1,
                      started_at = NULL, completed_at = NULL, error = NULL
                WHERE id = ? AND status = 'interrupted'`,
              session.id,
              turn.id,
            );
          });
          return session.id;
        });
      } catch (error) {
        const message = error instanceof Error && error.message.length > 0
          ? error.message
          : "Advisor session could not be started for the queued turn.";
        await this.failTurn(turn, message);
        continue;
      }

      void this.startTurnLoop(sessionId).catch((error) => console.error(`[owl-core] Advisor recovery loop failed for ${sessionId}`, error));
    }
  }

  /** Retry queued Advisor turns after their provider enters a probe window. */
  public async resumeProvider(provider: string): Promise<void> {
    if (this.config.isProviderPaused?.(provider)) return;
    await this.restartQueuedTurns(providerAliases(provider), `for provider ${provider}`);
  }

  /** Retry queued Advisor turns on the currently configured model, e.g. after the Advisor role moved off a paused provider. */
  public async retryQueuedTurns(): Promise<void> {
    let providerId: string;
    try {
      providerId = this.config.getAdvisorSettings().providerId;
    } catch (error) {
      console.error("[owl-core] Could not read Advisor settings to retry queued turns", error);
      return;
    }
    if (this.config.isProviderPaused?.(providerId)) return;
    // A loop that is draining already picks up the current model; replacing the session now would cut the in-flight turn short.
    await this.restartQueuedTurns(null, "after a model change", true);
  }

  private async restartQueuedTurns(providers: readonly string[] | null, label: string, skipDraining = false): Promise<void> {
    const sessions = this.config.db.all<{ id: string; owner_id: string; conversation_id: string; window_id: string | null }>(
      `SELECT session.id, conversation.owner_id, session.conversation_id, session.window_id
         FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
        WHERE ${providers ? `session.provider_id IN (${providers.map(() => "?").join(",")}) AND ` : ""}session.status IN ('running', 'suspended', 'ended')
          AND EXISTS (SELECT 1 FROM advisor_turns WHERE session_id = session.id AND status = 'queued')
        ORDER BY session.created_at DESC`,
      ...(providers ?? []),
    );
    // The newest session of each window carries that window's queue.
    const newestPerWindow = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
      const key = session.window_id ?? LEGACY_WINDOW_KEY;
      if (!newestPerWindow.has(key)) newestPerWindow.set(key, session);
    }
    for (const session of newestPerWindow.values()) {
      if (skipDraining && this.slotFor(session.window_id).turnLoopRunning) continue;
      try {
        const active = await this.ensureSession(session.owner_id, session.conversation_id);
        void this.startTurnLoop(active.id).catch((error) => console.error(`[owl-core] Advisor provider resume failed for ${active.id}`, error));
      } catch (error) {
        console.error(`[owl-core] Could not resume queued Advisor turns ${label}`, error);
      }
    }
  }

  /** Core shutdown: stop the child processes only. DB status reconciliation (running -> ended) is Core startup's job (AdvisorSessionManager.recoverOnStartup), not this call's. */
  public async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.slots.values()].map((slot) => this.chain(slot, () => this.stopSlotUnlocked(slot))));
  }

  private async stopSlotUnlocked(slot: WindowSlot): Promise<void> {
    if (slot.driver === null) return;
    const driver = slot.driver;
    this.forgetDriver(slot);
    await driver.stop("core_shutdown");
  }

  /** End the owned provider process groups without waiting for a turn to finish. */
  public stopImmediately(): void {
    this.stopped = true;
    for (const slot of this.slots.values()) {
      if (slot.driver === null) continue;
      const driver = slot.driver;
      this.forgetDriver(slot);
      this.terminateDriver(driver);
    }
  }

  private terminateDriver(driver: ProviderSession): void {
    if (driver.terminateImmediately) {
      driver.terminateImmediately();
      return;
    }
    // Third-party session implementations may not expose synchronous process
    // termination. Start their stop path, but never keep Owl alive waiting for it.
    void driver.stop("core_shutdown", 0).catch((error) =>
      console.error("[owl-core] Advisor provider termination failed during shutdown", error));
  }

  // ---------------------------------------------------------------------
  // Session (re)creation
  // ---------------------------------------------------------------------

  private async createSession(
    slot: WindowSlot,
    ownerId: string,
    conversationId: string,
    settings: AdvisorSettingsSnapshot,
  ): Promise<AdvisorSession> {
    this.requireSessionSupport();
    const { directory, session } = await this.withDirectoryLock(async () => {
      const built = await this.buildWorkingDirectory(conversationId);
      const started = await this.config.sessionManager.startSession(
        ownerId, conversationId, undefined, advisorWindowSettings(this.config.db).idle_timeout_seconds,
      );
      return { directory: built, session: started };
    });
    this.startingSessionIds.add(session.id);
    try {
      return await this.launchSession(slot, session, settings, directory);
    } finally {
      this.startingSessionIds.delete(session.id);
    }
  }

  private async launchSession(
    slot: WindowSlot,
    session: AdvisorSession,
    settings: AdvisorSettingsSnapshot,
    directory: AdvisorSessionDirectory,
    resumeProviderSessionId?: string,
  ): Promise<AdvisorSession> {
    const workspacePath = directory.cwd;
    const createProviderSession = this.requireSessionSupport();
    let driver: ProviderSession;
    try {
      driver = await createProviderSession({
        adapter: settings.harnessId,
        role: "advisor",
        model: settings.model,
        effort: settings.effort,
        cwd: workspacePath,
        env: this.buildChildEnv(session, workspacePath, settings.connectionEnv),
        system_prompt: this.systemPromptFor(settings, directory),
        ...(resumeProviderSessionId ? { resume_provider_session_id: resumeProviderSessionId } : {}),
        ...(this.config.canInstructCompaction?.(settings.harnessId) ? { compact_instructions: CONVERSATION_COMPACT_INSTRUCTIONS } : {}),
        on_unsolicited_reply: (unsolicited) => this.handleUnsolicitedReply(slot, session.id, unsolicited),
      });
    } catch (error) {
      await this.config.sessionManager.endSession(session.id, resumeProviderSessionId ? "resume_failed" : "spawn_failed");
      throw error;
    }

    // Until it becomes the slot's driver nothing else holds the new process, so a
    // shutdown or a failed record write while it starts must end it here.
    const abandon = async (reason: string): Promise<void> => {
      this.terminateDriver(driver);
      await this.config.sessionManager.endSession(session.id, reason);
    };
    if (this.stopped) {
      await abandon("core_restart");
      throw new AdvisorRuntimeStoppedError();
    }

    try {
      await this.config.sessionManager.activateSession(session.id, driver.pid, driver.provider_session_id);
      await this.config.sessionManager.setProviderConfig(session.id, {
        providerId: settings.providerId,
        harnessId: settings.harnessId,
        model: settings.model,
        effort: settings.effort ?? null,
        systemPromptSha256: hashSystemPrompt(settings.systemPrompt),
      });
      await this.config.sessionManager.setWorkspace(session.id, workspacePath);
    } catch (error) {
      await abandon("spawn_failed").catch((endError: unknown) => console.error(`[owl-core] Could not end Advisor session ${session.id}`, endError));
      throw error;
    }
    if (this.stopped) {
      await abandon("core_restart");
      throw new AdvisorRuntimeStoppedError();
    }

    this.sessionDirectories.set(session.id, directory);
    slot.driver = driver;
    slot.sessionId = session.id;
    slot.systemPrompt = settings.systemPrompt;
    void this.startTurnLoop(session.id).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${session.id}`, error));
    this.sweepAdvisorWorkspacesInBackground();

    return {
      ...session,
      status: "running",
      pid: driver.pid,
      provider_id: settings.providerId,
      harness_id: settings.harnessId,
      model: settings.model,
      effort: settings.effort ?? null,
      provider_session_id: driver.provider_session_id,
      workspace_path: workspacePath,
    };
  }

  /**
   * Reclaims workspaces/branches a replaced or conversation-switched session
   * left behind (GitGateway.sweepAdvisorWorkspaces), queued behind this
   * runtime's directory lock so it can never race a concurrent
   * session start or resume into removing the workspace one of them is about
   * to use. Never awaited by a caller: a sweep failure is logged and never
   * delays or fails a turn or Core startup.
   */
  public sweepWorkspaces(): Promise<void> {
    const git = this.config.git;
    const sweep = git?.sweepAdvisorWorkspaces;
    if (!git || !sweep) return Promise.resolve();
    return this.withDirectoryLock(() =>
      sweep.call(git).then(
        () => undefined,
        (error: unknown) => console.error("[owl-core] Advisor workspace sweep failed", error),
      ),
    );
  }

  private sweepAdvisorWorkspacesInBackground(): void {
    // Why not log here: sweepWorkspaces logs its own failures.
    void this.sweepWorkspaces();
  }

  /**
   * Posts a reply the provider produced on its own (for example when a
   * background task finishes) to the conversation of the most recent turn,
   * or to the session's own conversation when no turn ran yet. Handled in
   * arrival order; a failure is logged and never thrown.
   */
  private handleUnsolicitedReply(slot: WindowSlot, sessionId: string, unsolicited: { readonly reply: string; readonly usage: TokenUsage | null }): void {
    slot.unsolicitedChain = slot.unsolicitedChain
      .then(async () => {
        if (this.stopped || slot.sessionId !== sessionId) return;
        let conversationId: string;
        let origin: AdvisorTurnRequest["origin"];
        if (slot.lastTurnTarget !== null && slot.lastTurnTarget.sessionId === sessionId) {
          conversationId = slot.lastTurnTarget.conversationId;
          origin = slot.lastTurnTarget.origin;
        } else {
          const row = this.config.db.get<{ conversation_id: string }>(
            `SELECT conversation_id FROM advisor_sessions WHERE id = ?`,
            sessionId,
          );
          if (!row) return;
          conversationId = row.conversation_id;
          origin = { channel: "web" };
        }
        await this.recordUsageIfPresent(sessionId, unsolicited.usage);
        await this.config.sessionManager.recordActivity(sessionId);
        const parsed = parseAdvisorTurnReply(origin.channel, unsolicited.reply, ownerLanguage(this.config.db));
        await this.config.onReply(conversationId, parsed.reply, createUlid(), origin, parsed.suggested_actions, parsed.malformed);
      })
      .catch((error: unknown) => console.error(`[owl-core] Could not post an unsolicited Advisor reply for ${sessionId}`, error));
  }

  /** Moves turns still queued on ended sessions onto `toSessionId` and makes sure the turn loop sees them. */
  private async adoptQueuedTurns(toSessionId: string): Promise<void> {
    const orphaned = this.config.db.get<{ id: string }>(
      `SELECT turn.id FROM advisor_turns AS turn
         JOIN advisor_sessions AS session ON session.id = turn.session_id
        WHERE turn.status = 'queued' AND turn.session_id <> ? AND session.status = 'ended'
          AND session.window_id IS (SELECT window_id FROM advisor_sessions WHERE id = ?)
        LIMIT 1`,
      toSessionId,
      toSessionId,
    );
    if (!orphaned) return;
    await this.enqueueTurnMutation("turns_adopted", { session_id: toSessionId }, (transaction) => {
      transaction.run(
        `UPDATE advisor_turns SET session_id = ?
          WHERE status = 'queued' AND session_id <> ?
            AND session_id IN (SELECT id FROM advisor_sessions WHERE status = 'ended'
                                  AND window_id IS (SELECT window_id FROM advisor_sessions WHERE id = ?))`,
        toSessionId,
        toSessionId,
        toSessionId,
      );
    });
    void this.startTurnLoop(toSessionId).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${toSessionId}`, error));
  }

  private requireSessionSupport(): (request: ProviderSessionRequest) => Promise<ProviderSession> {
    const createProviderSession = this.config.providerClient.createSession;
    if (!createProviderSession) {
      throw new Error("Advisor requires a provider with session support");
    }
    return createProviderSession.bind(this.config.providerClient);
  }

  private async buildWorkingDirectory(conversationId: string): Promise<AdvisorSessionDirectory> {
    if (this.config.git) {
      if (!this.config.git.resolveAdvisorSessionDirectory) {
        throw new Error("The configured Git gateway does not support Advisor session directories.");
      }
      return this.config.git.resolveAdvisorSessionDirectory({ conversation_id: conversationId });
    }
    return { kind: "direct", cwd: resolveAdvisorWorkingDirectory(this.config.db, this.config.owlRoot, conversationId) };
  }

  /**
   * The system prompt actually sent to the provider for one session start:
   * settings.systemPrompt plus an Advisor workspace note, appended only when
   * a Git gateway resolves the session directory. Kept separate from
   * settings.systemPrompt itself so a workspace change alone never counts as
   * a system-prompt change.
   */
  private systemPromptFor(settings: AdvisorSettingsSnapshot, directory: AdvisorSessionDirectory): string {
    if (!this.config.git?.resolveAdvisorSessionDirectory) return settings.systemPrompt;
    return `${settings.systemPrompt}\n\n${renderAdvisorWorkspaceNote(directory)}`;
  }

  /**
   * Prepare (and sync to the latest base) the shared worktree an Advisor
   * session asked for. `projectId` null targets the session's own repository.
   */
  public async prepareWorkspace(sessionId: string, projectId: string | null): Promise<AdvisorWorkspacePreparation> {
    const session = this.config.db.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM advisor_sessions WHERE id = ? AND status != 'ended'",
      sessionId,
    );
    if (!session) throw new AdvisorSessionNotFoundError(sessionId);
    const prepare = this.config.git?.prepareAdvisorWorkspace;
    if (!prepare) throw new Error("The configured Git gateway does not support Advisor workspaces.");
    const prepared = await prepare.call(this.config.git, { conversation_id: session.conversation_id, project_id: projectId });
    if (prepared.ok && prepared.kind === "worktree") {
      const targets = this.preparedTargets.get(sessionId) ?? new Set<string | null>();
      targets.add(projectId);
      this.preparedTargets.set(sessionId, targets);
    }
    return prepared;
  }

  /** Merge the session's shared worktree into base and remove it; `projectId` null targets the session's own repository. */
  public async finishWorkspace(sessionId: string, projectId: string | null): Promise<AdvisorWorkspacePreparation> {
    const session = this.config.db.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM advisor_sessions WHERE id = ? AND status != 'ended'",
      sessionId,
    );
    if (!session) throw new AdvisorSessionNotFoundError(sessionId);
    const finish = this.config.git?.finishAdvisorWorkspace;
    if (!finish) throw new Error("The configured Git gateway does not support Advisor workspaces.");
    return finish.call(this.config.git, { conversation_id: session.conversation_id, project_id: projectId });
  }

  private async includeWorkspaceNotice(conversationId: string, sessionId: string, reply: string): Promise<string> {
    const notice = await this.getWorkspaceNotice(conversationId, sessionId);
    return notice ? `${reply.trimEnd()}\n\n${notice}` : reply;
  }

  private async getWorkspaceNotice(conversationId: string, sessionId: string): Promise<string | null> {
    const inspect = this.config.git?.inspectAdvisorWorkspace;
    if (!inspect) return null;
    const session = this.config.db.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM advisor_sessions WHERE id = ?",
      sessionId,
    );
    if (!session) return null;
    const targets = new Set<string | null>([null, ...(this.preparedTargets.get(sessionId) ?? [])]);
    for (const projectId of targets) {
      try {
        const status = await inspect.call(this.config.git, { conversation_id: session.conversation_id, project_id: projectId });
        if (!status.ok) {
          console.warn(`[owl-core] Could not inspect Advisor workspace for ${conversationId}: ${status.message}`);
          continue;
        }
        if (!status.worktree_path) continue;
        const key = `${conversationId}\u0000${status.worktree_path}`;
        const previouslyDirty = this.workspaceWasDirty.get(key) ?? false;
        this.workspaceWasDirty.set(key, status.dirty);
        if (status.dirty && !previouslyDirty) return ADVISOR_TEXT[ownerLanguage(this.config.db)].dirtyWorkspace(status.worktree_path);
      } catch (error) {
        console.warn(`[owl-core] Could not inspect Advisor workspace for ${conversationId}`, error);
      }
    }
    return null;
  }

  private async notifyRetainedWorkspace(sessionId: string): Promise<void> {
    const session = this.config.db.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM advisor_sessions WHERE id = ?",
      sessionId,
    );
    if (!session) return;
    const notice = await this.getWorkspaceNotice(session.conversation_id, sessionId);
    if (!notice) return;
    try {
      await this.config.onReply(session.conversation_id, notice, createUlid(), { channel: "web" }, []);
    } catch (error) {
      console.warn(`[owl-core] Could not notify about retained Advisor workspace for ${session.conversation_id}`, error);
    }
  }

  /** The Project a session's window is dedicated to; null for the general window and legacy sessions. */
  private windowProjectId(sessionId: string): string | null {
    return this.config.db.get<{ project_id: string | null }>(
      "SELECT w.project_id FROM advisor_sessions s JOIN advisor_windows w ON w.id = s.window_id WHERE s.id = ?",
      sessionId,
    )?.project_id ?? null;
  }

  /**
   * The Advisor identity plus, for a custom provider, its endpoint/key
   * travel on the session request. The provider owns the base agent
   * environment, which excludes Owl's own credentials; OWL_AGENT_* is set
   * last so a custom provider's env can never shadow the agent identity.
   */
  private buildChildEnv(session: AdvisorSession, cwd: string, connectionEnv: Readonly<Record<string, string>> | undefined): Record<string, string> {
    const projectId = this.windowProjectId(session.id);
    return {
      ...(connectionEnv ?? {}),
      ...(projectId ? { OWL_PROJECT_ID: projectId } : {}),
      OWL_AGENT_ROLE: "advisor",
      OWL_AGENT_RUN_ID: session.id,
      OWL_AGENT_CWD: cwd,
    };
  }

  // ---------------------------------------------------------------------
  // Turn queue
  // ---------------------------------------------------------------------

  private startTurnLoop(sessionId: string): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const slot = this.slotForSession(sessionId);
    if (slot.turnLoopRunning) {
      // The loop is busy draining another session's queue; ask it to switch
      // to this one once that queue is empty instead of starting a second
      // loop (there is only ever one turn loop per window).
      slot.turnLoopKick = sessionId;
      return Promise.resolve();
    }
    slot.turnLoopRunning = true;
    return this.runTurnLoop(slot, sessionId);
  }

  private async runTurnLoop(slot: WindowSlot, initialSessionId: string): Promise<void> {
    let sessionId = initialSessionId;
    try {
      for (;;) {
        // Re-read the current active session on every iteration: ensureSession
        // may have replaced it (model change, crash recovery) while this loop
        // was mid-turn, and the queue now lives under the new session id.
        const targetSessionId = slot.sessionId ?? sessionId;
        if (this.config.isProviderPaused?.(this.advisorProviderId(targetSessionId))) return;
        const turnRow = this.dequeueOldestQueuedTurn(targetSessionId);
        if (!turnRow) {
          if (slot.turnLoopKick !== null) {
            sessionId = slot.turnLoopKick;
            slot.turnLoopKick = null;
            continue;
          }
          return;
        }
        try {
          // A send failure may move the turn (and the rest of the queue) to a
          // replacement session; keep draining whichever session it ended on.
          sessionId = await this.processTurn(slot, targetSessionId, turnRow);
        } catch (error) {
          const message = error instanceof Error && error.message.length > 0
            ? error.message
            : ADVISOR_TEXT[ownerLanguage(this.config.db)].turnFailed;
          await this.failTurn(turnRow, message);
        }
      }
    } finally {
      slot.turnLoopRunning = false;
      if (slot.turnLoopKick !== null && !this.stopped) {
        const kicked = slot.turnLoopKick;
        slot.turnLoopKick = null;
        void this.startTurnLoop(kicked).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${kicked}`, error));
      }
    }
  }

  private dequeueOldestQueuedTurn(sessionId: string): AdvisorTurnRow | undefined {
    return this.config.db.get<AdvisorTurnRow>(
      `SELECT * FROM advisor_turns WHERE session_id = ? AND status = 'queued' ORDER BY queued_at ASC, rowid ASC LIMIT 1`,
      sessionId,
    );
  }

  /**
   * Sends one turn and waits for it to settle. Returns the session the turn
   * ended on: normally `sessionId`, or the replacement session when the send
   * failed and was retried once on a fresh driver.
   */
  private async processTurn(slot: WindowSlot, sessionId: string, turnRow: AdvisorTurnRow): Promise<string> {
    await this.markTurnRunning(turnRow.id);
    await this.config.sessionManager.recordActivity(sessionId);

    const loadedRequest = this.loadTurnRequest(turnRow);
    this.pendingTurnPayloads.delete(turnRow.id);
    // Read at send time, from the persisted event, so a message queued before the previous reply
    // finished and a turn recovered after a restart both still carry that reply's action results.
    // Keyed by the preceding turn, not the conversation's latest reply: when that turn left no reply
    // (failed, dropped), an older reply's results were already handed over and must not come back.
    let turnRequest = loadedRequest;
    if (turnRow.followup_of_turn_id !== null) {
      // The source reply is named by the row, not found by position: a spontaneous source has no turn row.
      turnRequest = {
        ...loadedRequest,
        text: buildFollowupTurnText(
          loadSourceActionResults(this.config.db, turnRow.followup_of_turn_id),
          loadSourceFailures(this.config.db, turnRow.followup_of_turn_id),
        ),
      };
    } else {
      const previousReply = this.config.db.get<{ payload_json: string }>(
        `SELECT payload_json FROM events WHERE type = 'advisor.responded'
           AND json_extract(payload_json, '$.turn_id') = (
             SELECT id FROM advisor_turns WHERE conversation_id = ? AND (queued_at, rowid) < (SELECT queued_at, rowid FROM advisor_turns WHERE id = ?)
             ORDER BY queued_at DESC, rowid DESC LIMIT 1)
         ORDER BY rowid DESC LIMIT 1`,
        turnRow.conversation_id, turnRow.id,
      );
      let actionResults = "";
      try {
        const previousTurnId = previousReply ? JSON.parse(previousReply.payload_json).turn_id : null;
        // Includes the connector's delivery failures, which a queued turn receives in place of a follow-up (6.5).
        if (typeof previousTurnId === "string") actionResults = loadSourceActionResults(this.config.db, previousTurnId);
      } catch { /* an unreadable payload just means no results to hand over */ }
      turnRequest = actionResults
        ? { ...loadedRequest, text: `<owl-action-results>\n${actionResults}\n</owl-action-results>\n\n${loadedRequest.text}` }
        : loadedRequest;
    }

    const driver = slot.driver;
    if (!driver || slot.sessionId !== sessionId) {
      const message = "The advisor session process is not running.";
      await this.failTurn(turnRow, message);
      return sessionId;
    }

    const windowProjectId = this.windowProjectId(sessionId);
    const memory = await this.config.memoryInjector?.compose({ role: "advisor", query: searchQuery("advisor", { owner_text: turnRequest.text }), recall_query: turnRequest.text, start_query: this.activeWorkTexts(windowProjectId), project_id: windowProjectId, session_id: sessionId });
    const knowledgeBlock = memory ? `\n\n${memory}` : "";
    const payload = {
      turn_id: turnRequest.turn_id,
      text: applyAdvisorInterfaceInstructions(
        appendAdvisorWorkCatalog(
          appendAdvisorProjectCatalog(
            turnRequest.text,
            this.config.db,
            windowProjectId === null ? null : { projectId: windowProjectId, backlogLimit: advisorWindowSettings(this.config.db).project_backlog_limit },
          ) + knowledgeBlock,
          this.config.db,
          { projectId: windowProjectId },
        ),
        turnRequest.origin.channel,
      ),
      attachment_paths: turnRequest.attachment_paths,
    };

    const currentPrompt = this.config.getAdvisorSettings().systemPrompt;
    const promptUpdated = slot.systemPrompt !== null && slot.systemPrompt !== currentPrompt;
    if (promptUpdated) {
      const workspace = this.config.db.get<{ workspace_path: string | null }>(
        "SELECT workspace_path FROM advisor_sessions WHERE id = ?",
        sessionId,
      );
      const directory = this.sessionDirectories.get(sessionId) ?? { kind: "direct" as const, cwd: workspace?.workspace_path ?? "" };
      const composedPrompt = this.systemPromptFor(this.config.getAdvisorSettings(), directory);
      payload.text = `${OWL_INSTRUCTIONS_UPDATE_HEADER}\n--- BEGIN UPDATED OWL INSTRUCTIONS ---\n${composedPrompt}\n--- END UPDATED OWL INSTRUCTIONS ---\n\n${payload.text}`;
    }
    payload.text = this.takeHistoryBlock(slot, payload.text);
    slot.lastTurnTarget = { sessionId, conversationId: turnRow.conversation_id, origin: turnRequest.origin };
    const memoryRetry = { text: turnRequest.text, memory: knowledgeBlock };

    let settleSessionId = sessionId;
    let settleDriver = driver;
    try {
      if (driver.exited === true) {
        throw new Error("The advisor session process has already exited.");
      }
      await driver.send(payload);
    } catch (error) {
      const recovered = await this.retrySendOnFreshSession(slot, sessionId, turnRow, driver, payload, error, memoryRetry);
      if (recovered.driver === null) {
        return recovered.sessionId;
      }
      this.followTurnTarget(slot, sessionId, recovered.sessionId);
      settleSessionId = recovered.sessionId;
      settleDriver = recovered.driver;
    }

    await this.recordPromptUpdate(slot, settleSessionId, promptUpdated, currentPrompt);
    if (await this.consumeUntilTurnSettles(slot, settleSessionId, turnRow, settleDriver) === "settled") return settleSessionId;

    // The session resumed from suspension died before its first turn settled:
    // the turn goes to a fresh session that is handed the window history.
    const recovered = await this.retrySendOnFreshSession(
      slot, settleSessionId, turnRow, settleDriver, payload, new Error("The suspended Advisor session could not be resumed."), memoryRetry,
    );
    if (recovered.driver === null) return recovered.sessionId;
    this.followTurnTarget(slot, settleSessionId, recovered.sessionId);
    await this.recordPromptUpdate(slot, recovered.sessionId, promptUpdated, currentPrompt);
    await this.consumeUntilTurnSettles(slot, recovered.sessionId, turnRow, recovered.driver);
    return recovered.sessionId;
  }

  private followTurnTarget(slot: WindowSlot, fromSessionId: string, toSessionId: string): void {
    if (slot.lastTurnTarget?.sessionId === fromSessionId) slot.lastTurnTarget = { ...slot.lastTurnTarget, sessionId: toSessionId };
  }

  private async recordPromptUpdate(slot: WindowSlot, sessionId: string, promptUpdated: boolean, prompt: string): Promise<void> {
    if (!promptUpdated) return;
    slot.systemPrompt = prompt;
    try {
      await this.config.sessionManager.setSystemPromptSha256(sessionId, hashSystemPrompt(prompt));
    } catch (error) {
      console.warn(`[owl-core] Could not record the Advisor system prompt hash for ${sessionId}`, error);
    }
  }

  /** Stops a driver that can no longer take turns and forgets it, so the next ensureSession replaces it. */
  private async discardDriver(slot: WindowSlot, driver: ProviderSession, reason: string): Promise<void> {
    if (slot.driver === driver) this.forgetDriver(slot);
    try {
      await driver.stop(reason);
    } catch (error) {
      console.warn(`[owl-core] Could not stop the discarded Advisor driver (${reason})`, error);
    }
  }

  /**
   * A send failure means the held driver is dead or unusable (for example it
   * exited while idle). Discard it, obtain a replacement session through
   * ensureSession (the crash path: end + fresh driver) and
   * resend exactly once. The turn is failed when that also fails. Returns
   * the session the queue now lives on and, on success, the driver to
   * consume the turn's events from.
   */
  private async retrySendOnFreshSession(
    slot: WindowSlot,
    sessionId: string,
    turnRow: AdvisorTurnRow,
    driver: ProviderSession,
    payload: Parameters<ProviderSession["send"]>[0],
    sendError: unknown,
    memoryRetry: { readonly text: string; readonly memory: string },
  ): Promise<{ readonly sessionId: string; readonly driver: ProviderSession | null }> {
    const sendMessage = sendError instanceof Error && sendError.message.length > 0 ? sendError.message : String(sendError);
    await this.discardDriver(slot, driver, "send_failed");
    if (this.stopped) {
      await this.failTurn(turnRow, sendMessage);
      return { sessionId, driver: null };
    }
    const conversation = this.config.db.get<{ owner_id: string }>(
      `SELECT owner_id FROM conversations WHERE id = ?`,
      turnRow.conversation_id,
    );
    if (!conversation) {
      await this.failTurn(turnRow, sendMessage);
      return { sessionId, driver: null };
    }

    let freshSession: AdvisorSession;
    try {
      freshSession = await this.ensureSession(conversation.owner_id, turnRow.conversation_id);
    } catch (error) {
      const message = error instanceof Error && error.message.length > 0 ? error.message : sendMessage;
      await this.failTurn(turnRow, message);
      return { sessionId, driver: null };
    }
    const freshDriver = slot.driver;
    if (freshDriver === null || slot.sessionId !== freshSession.id) {
      await this.failTurn(turnRow, sendMessage);
      return { sessionId, driver: null };
    }
    if (freshSession.id !== sessionId) {
      await this.moveTurnsToSession(sessionId, freshSession.id, turnRow.id);
    }

    let resend = payload;
    if (freshSession.id !== sessionId) {
      // The fresh session has seen nothing: rebuild the start catalog for it instead of the old session's delta.
      const fresh = await this.config.memoryInjector?.compose({ role: "advisor", query: searchQuery("advisor", { owner_text: memoryRetry.text }), recall_query: memoryRetry.text, start_query: this.activeWorkTexts(this.windowProjectId(freshSession.id)), project_id: this.windowProjectId(freshSession.id), session_id: freshSession.id });
      const block = fresh ? `\n\n${fresh}` : "";
      resend = { ...payload, text: memoryRetry.memory && payload.text.includes(memoryRetry.memory) ? payload.text.replace(memoryRetry.memory, () => block) : payload.text + block };
    }
    resend = { ...resend, text: this.takeHistoryBlock(slot, resend.text) };
    try {
      await freshDriver.send(resend);
    } catch (error) {
      await this.discardDriver(slot, freshDriver, "send_failed");
      const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
      await this.failTurn(turnRow, message);
      return { sessionId: freshSession.id, driver: null };
    }
    return { sessionId: freshSession.id, driver: freshDriver };
  }

  /**
   * Reconstructs the outgoing turn payload. The in-memory map (populated at
   * enqueueTurn time) is the fast path; a requeued turn recovered after a
   * restart (recoverTurns) has no in-memory entry, so its text is rebuilt
   * from the user message it was queued for.
   */
  private loadTurnRequest(turnRow: AdvisorTurnRow): AdvisorTurnRequest {
    const cached = this.pendingTurnPayloads.get(turnRow.id);
    if (cached) {
      return cached;
    }
    if (turnRow.followup_of_turn_id !== null) {
      // user_message_id is the source reply, not an Owner message: no attachments, status answers or handoffs.
      return { turn_id: turnRow.id, text: ADVISOR_FOLLOWUP_TURN_TEXT, origin: this.resolveTurnOrigin(turnRow), attachment_paths: [] };
    }
    const message = this.config.db.get<{ body: string }>(
      `SELECT body FROM messages WHERE id = ?`,
      turnRow.user_message_id,
    );
    if (!message || typeof message.body !== "string" || message.body.trim().length === 0) {
      throw new Error(`Advisor turn ${turnRow.id} references a missing or empty user message.`);
    }
    const { paths: attachmentPaths, notes } = this.config.resolveAttachmentPaths(turnRow.user_message_id);
    const statusBlock = this.config.resolveStatusExchangesBlock?.(turnRow.user_message_id);
    const handoffBlock = this.config.resolveWindowHandoffBlock?.(turnRow.user_message_id);
    return {
      turn_id: turnRow.id,
      text: [message.body, ...(notes.length > 0 ? [externalJsonBlock("owl-attachment-notes", notes)] : []), ...(statusBlock ? [statusBlock] : []), ...(handoffBlock ? [handoffBlock] : [])].join("\n\n"),
      origin: this.resolveTurnOrigin(turnRow),
      attachment_paths: attachmentPaths,
    };
  }

  /**
   * Migration 006 backfills the channel for recoverable historical turns.
   * Keep the lookup here as a defensive final fallback for databases or rows
   * where that evidence was unavailable during migration. A channel is used
   * only when the conversation provider matches the turn provider; no
   * configured connector channel is guessed.
   */
  private resolveTurnOrigin(turnRow: AdvisorTurnRow): AdvisorTurnRequest["origin"] {
    let channelId = turnRow.origin_channel_id ?? undefined;
    if (!channelId && (turnRow.origin_channel === "slack" || turnRow.origin_channel === "discord")) {
      const conversation = this.config.db.get<{ channel: string; dm_ref: string | null }>(
        `SELECT channel, dm_ref FROM conversations WHERE id = ?`,
        turnRow.conversation_id,
      );
      if (conversation?.channel === turnRow.origin_channel && typeof conversation.dm_ref === "string" && conversation.dm_ref.length > 0) {
        channelId = conversation.dm_ref;
      }
    }
    return {
      channel: turnRow.origin_channel,
      channel_id: channelId,
      ref: turnRow.origin_ref ?? undefined,
    };
  }

  /**
   * Drains SessionEvents for one in-flight turn: ignores deltas from other
   * turns, forwards compaction to handleCompaction without ending the wait,
   * and settles (marks completed/failed, calls onReply/onError) on the
   * matching turn.completed/turn.failed or on session.exited/stream end.
   */
  private async consumeUntilTurnSettles(
    slot: WindowSlot,
    sessionId: string,
    turnRow: AdvisorTurnRow,
    driver: ProviderSession,
  ): Promise<"settled" | "resume_failed"> {
    const iterator = driver.events()[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done || step.value === undefined) {
        const message = "The advisor session ended without completing this turn.";
        await this.failTurn(turnRow, message);
        return "settled";
      }

      const event: SessionEvent = step.value;
      switch (event.type) {
        case "session.ready":
          await this.config.sessionManager.setProviderSessionId(sessionId, event.provider_session_id);
          break;

        case "turn.delta":
          break;

        case "tool.web_research":
          try {
            this.config.onWebResearch?.(event.capture, {
              conversation_id: turnRow.conversation_id,
              turn_id: event.turn_id,
            });
          } catch {
            // Research recording is fire-and-forget and cannot fail a turn.
          }
          break;

        case "tool.web_research_failed":
          try {
            this.config.onWebResearchFailed?.(event.error, {
              conversation_id: turnRow.conversation_id,
              turn_id: event.turn_id,
            });
          } catch {
            // Reporting the failure must not fail the turn either.
          }
          break;

        case "turn.completed": {
          if (event.turn_id !== turnRow.id) {
            break;
          }
          if (slot.unconfirmedResume === sessionId) slot.unconfirmedResume = null;
          await this.config.sessionManager.recordActivity(sessionId);
          const usageJson = await this.recordUsageIfPresent(sessionId, event.usage);
          const parsed = parseAdvisorTurnReply(turnRow.origin_channel, event.reply, ownerLanguage(this.config.db));
          const reply = await this.includeWorkspaceNotice(turnRow.conversation_id, sessionId, parsed.reply);
          const replyMessageId = await this.config.onReply(
            turnRow.conversation_id,
            reply,
            turnRow.id,
            this.resolveTurnOrigin(turnRow),
            parsed.suggested_actions,
            parsed.malformed,
          );
          await this.markTurnCompleted(turnRow.id, usageJson, replyMessageId);
          const startedAt = this.config.db.get<{ started_at: string | null }>(
            `SELECT started_at FROM advisor_turns WHERE id = ?`, turnRow.id,
          )?.started_at;
          const sessionProvider = this.config.db.get<{ provider_id: string | null }>(
            `SELECT provider_id FROM advisor_sessions WHERE id = ?`, sessionId,
          )?.provider_id;
          if (sessionProvider && startedAt) await this.config.onProviderSucceeded?.(sessionProvider, startedAt);
          this.sweepAdvisorWorkspacesInBackground();
          return "settled";
        }

        case "turn.failed": {
          if (event.turn_id !== turnRow.id) {
            break;
          }
          const resumeUnconfirmed = slot.unconfirmedResume === sessionId;
          if (resumeUnconfirmed) slot.unconfirmedResume = null;
          // The failed turn ran no owl-actions (they are read only from turn.completed), so resending it on a fresh session cannot run an action twice.
          if (resumeUnconfirmed && event.provider_error?.code === RESUME_FAILED_CODE) {
            console.warn(`[owl-core] Resumed Advisor session ${sessionId} found no conversation to resume: ${event.error}`);
            slot.pendingHistoryBlock = this.buildHistoryBlock({ window_id: this.windowIdOfSession(sessionId), conversation_id: turnRow.conversation_id });
            await this.config.sessionManager.endSession(sessionId, "resume_failed");
            return "resume_failed";
          }
          const rateLimit = rateLimitInfoFromEvent(event);
          if (rateLimit !== null) {
            await this.failRateLimitedTurn(sessionId, turnRow, event.error, rateLimit, event.provider_error);
          } else {
            await this.failTurn(turnRow, event.error, event.provider_error);
          }
          this.sweepAdvisorWorkspacesInBackground();
          return "settled";
        }

        case "session.compacted":
          await this.handleCompaction(sessionId, turnRow.conversation_id, event);
          break;

        case "session.exited": {
          // Core shutdown deliberately leaves running turns for
          // recoverTurns() to retry on the next Core's fresh session. The
          // driver's SIGTERM exit event is expected during that shutdown.
          if (this.stopped) {
            return "settled";
          }
          if (slot.sessionId === sessionId) this.forgetDriver(slot);
          if (slot.unconfirmedResume === sessionId) {
            slot.unconfirmedResume = null;
            console.warn(`[owl-core] Resumed Advisor session ${sessionId} exited before its first turn settled: ${driver.exit_detail ?? event.stderr_tail}`);
            slot.pendingHistoryBlock = this.buildHistoryBlock({ window_id: this.windowIdOfSession(sessionId), conversation_id: turnRow.conversation_id });
            await this.config.sessionManager.endSession(sessionId, "resume_failed");
            return "resume_failed";
          }
          const message = event.stderr_tail.length > 0
            ? event.stderr_tail
            : `The advisor session process exited unexpectedly (exit_code=${String(event.exit_code)}, signal=${String(event.signal)}).`;
          console.error(`[owl-core] Advisor session ${sessionId} ended while a turn was running: ${driver.exit_detail ?? message}`);
          await this.config.sessionManager.endSession(sessionId, "crashed");
          await this.failTurn(turnRow, message);
          return "settled";
        }

        default:
          break;
      }
    }
  }

  private windowIdOfSession(sessionId: string): string | null {
    return this.config.db.get<{ window_id: string | null }>("SELECT window_id FROM advisor_sessions WHERE id = ?", sessionId)?.window_id ?? null;
  }

  private async recordUsageIfPresent(sessionId: string, usage: TokenUsage | null): Promise<string | null> {
    if (!usage) {
      return null;
    }
    const usageJson = JSON.stringify(usage);
    await this.config.sessionManager.recordUsage(sessionId, usageJson);
    return usageJson;
  }

  private async handleCompaction(
    sessionId: string,
    conversationId: string,
    event: SessionEvent & { type: "session.compacted" },
  ): Promise<void> {
    const sessionRow = this.config.db.get<{
      provider_id: string | null;
      model: string | null;
      compaction_count: number;
    }>(`SELECT provider_id, model, compaction_count FROM advisor_sessions WHERE id = ?`, sessionId);

    // After compaction the model no longer holds the start catalog: inject it again on the next turn.
    this.config.memoryInjector?.resetSession(sessionId);
    // The summary is only a knowledge note: when the storage is unavailable the compaction is still recorded.
    const provider = sessionRow?.provider_id ?? "unknown";
    const model = sessionRow?.model ?? "unknown";
    const index = (sessionRow?.compaction_count ?? 0) + 1;
    const { path, captured } = await (this.config.conversationLog
      ? this.config.conversationLog.writer.write({
        sessionId, conversationId, cause: event.cause, summary: event.summary, transcriptPath: event.transcript_path, provider, model, index,
      }).then((result) => ({ path: result.path, captured: result.path !== null }))
      : this.config.memorySaver.saveCompactionSummary(sessionId, {
        conversationId, cause: event.cause, preTokens: event.pre_tokens, summary: event.summary, provider, model, index, transcriptPath: event.transcript_path,
      })).catch((error: unknown) => {
      console.warn("[owl-core] Could not save the compaction summary", error);
      return { path: null, captured: false };
    });

    const compactionId = createUlid();
    const now = utcNow();
    await this.enqueueTurnMutation(
      "compaction_recorded",
      { session_id: sessionId, compaction_id: compactionId },
      (transaction) => {
        transaction.run(
          `INSERT INTO advisor_compactions
             (id, session_id, conversation_id, cause, pre_tokens, captured, summary_path, transcript_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          compactionId,
          sessionId,
          conversationId,
          event.cause,
          event.pre_tokens,
          captured ? 1 : 0,
          path,
          event.transcript_path,
          now,
        );
      },
    );

    await this.config.sessionManager.recordCompaction(sessionId, compactionId);
  }

  // ---------------------------------------------------------------------
  // advisor_turns DB writes (WriteLane; advisor_turns has no CoreDatabase
  // reducer of its own, so writes go straight through a transaction + a
  // lightweight system.alert event, mirroring AdvisorSessionManager's
  // enqueueMutation pattern).
  // ---------------------------------------------------------------------

  private markTurnRunning(turnId: string): Promise<void> {
    const now = utcNow();
    return this.enqueueTurnMutation("turn_running", { turn_id: turnId }, (transaction) => {
      transaction.run(`UPDATE advisor_turns SET status = 'running', started_at = ? WHERE id = ?`, now, turnId);
    });
  }

  /** Re-homes the retried turn (if any) and every still-queued turn of a replaced session onto its replacement. */
  private moveTurnsToSession(fromSessionId: string, toSessionId: string, turnId: string | null): Promise<void> {
    return this.enqueueTurnMutation(
      "turns_moved",
      { turn_id: turnId, from_session_id: fromSessionId, session_id: toSessionId },
      (transaction) => {
        if (turnId !== null) {
          transaction.run(`UPDATE advisor_turns SET session_id = ? WHERE id = ?`, toSessionId, turnId);
        }
        transaction.run(
          `UPDATE advisor_turns SET session_id = ? WHERE session_id = ? AND status = 'queued'`,
          toSessionId,
          fromSessionId,
        );
      },
    );
  }

  private markTurnCompleted(turnId: string, usageJson: string | null, replyMessageId: string | null): Promise<void> {
    const now = utcNow();
    return this.enqueueTurnMutation("turn_completed", { turn_id: turnId }, (transaction) => {
      transaction.run(
        `UPDATE advisor_turns
            SET status = 'completed', completed_at = ?, usage_json = ?, reply_message_id = ?
          WHERE id = ?`,
        now,
        usageJson,
        replyMessageId,
        turnId,
      );
    });
  }

  private markTurnFailed(turnId: string, errorMessage: string, providerError?: ProviderErrorRecord): Promise<void> {
    const now = utcNow();
    return this.enqueueTurnMutation("turn_failed", { turn_id: turnId }, (transaction) => {
      transaction.run(
        `UPDATE advisor_turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
        now,
        errorMessage,
        turnId,
      );
      if (providerError) insertProviderError(transaction, turnId, "advisor", providerError);
    });
  }

  /** Titles and summaries of the active Works: search material for the Advisor start catalog (design §6.2). */
  private activeWorkTexts(projectId: string | null): string[] {
    const rows = this.config.db.all<{ title: string; summary: string }>(
      `SELECT title, summary FROM works WHERE state IN ('ready','running','judgement_waiting','paused') AND archived_at IS NULL${projectId === null ? "" : " AND project_id = ?"} ORDER BY updated_at DESC LIMIT 5`,
      ...(projectId === null ? [] : [projectId]),
    );
    return rows.flatMap((row) => [row.title, row.summary]);
  }

  private async failTurn(turnRow: AdvisorTurnRow, errorMessage: string, providerError?: ProviderErrorRecord): Promise<void> {
    const current = this.config.db.get<{ status: AdvisorTurnStatus }>(
      `SELECT status FROM advisor_turns WHERE id = ?`,
      turnRow.id,
    );
    if (!current || current.status === "completed" || current.status === "failed") {
      return;
    }
    await this.markTurnFailed(turnRow.id, errorMessage, providerError);
    try {
      await this.config.onError(
        turnRow.conversation_id,
        errorMessage,
        turnRow.id,
        this.resolveTurnOrigin(turnRow),
      );
    } catch (error) {
      // The turn is already durably failed. Keep the loop alive, but retain a
      // clear lifecycle error if the user-facing error message could not be
      // persisted.
      console.error(`[owl-core] Failed to surface Advisor turn ${turnRow.id} failure`, error);
    }
  }

  private async failRateLimitedTurn(
    sessionId: string,
    turnRow: AdvisorTurnRow,
    errorMessage: string,
    rateLimit: RateLimitInfo,
    providerError?: ProviderErrorRecord,
  ): Promise<void> {
    const current = this.config.db.get<{ status: AdvisorTurnStatus }>(
      `SELECT status FROM advisor_turns WHERE id = ?`,
      turnRow.id,
    );
    if (!current || current.status === "completed" || current.status === "failed") return;

    // Mark the turn failed before any reply work so a restart cannot resend
    // this same request after a rate-limit response.
    await this.markTurnFailed(turnRow.id, errorMessage, providerError);

    let nextAttemptAt: string | null = null;
    try {
      const pause = await this.config.onProviderRateLimited?.(this.advisorProviderId(sessionId), rateLimit);
      nextAttemptAt = pause?.resume_at ?? null;
    } catch (error) {
      console.error(`[owl-core] Could not record the Advisor Provider rate limit for turn ${turnRow.id}`, error);
    }

    const reply = formatAdvisorRateLimitReply(
      ownerLanguage(this.config.db),
      rateLimit.resets_at,
      nextAttemptAt,
    );
    try {
      await this.config.onReply(
        turnRow.conversation_id,
        reply,
        turnRow.id,
        this.resolveTurnOrigin(turnRow),
        [],
      );
    } catch (error) {
      console.error(`[owl-core] Failed to surface Advisor rate limit for turn ${turnRow.id}`, error);
    }
  }

  private advisorProviderId(sessionId: string): string {
    const session = this.config.db.get<{ provider_id: string | null }>(
      `SELECT provider_id FROM advisor_sessions WHERE id = ?`,
      sessionId,
    );
    return session?.provider_id ?? this.config.getAdvisorSettings().providerId;
  }

  private enqueueTurnMutation(
    operation: string,
    payload: Record<string, unknown>,
    mutateState: (transaction: CoreWriteLaneTransaction) => void,
  ): Promise<void> {
    const eventId = createUlid();
    return this.writeLane
      .write({
        mutateState,
        event: {
          id: eventId,
          idempotencyKey: `advisor-turn:${operation}:${eventId}`,
          type: "system.alert",
          payload: { operation, ...payload },
        },
        outbox: [],
      })
      .then(() => undefined);
  }
}

function hashSystemPrompt(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex");
}

// AdvisorSessionRuntime: core-side orchestrator that bridges
// AdvisorSessionManager (DB state, persistent-session contract) with a
// provider-neutral ProviderSession (child-process I/O, driven
// today by AdvisorSessionDriver, agent-runtime Phase 2). It owns the single
// long-lived Advisor session/process this Owl instance runs at a time (one
// owner-wide Advisor session shared by all interfaces), the FIFO turn queue
// backing it (advisor_turns), and compaction capture (advisor_compactions).
//

import { resolve } from "node:path";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { applyAdvisorInterfaceInstructions, isProviderResumeUnsupportedError, parseAdvisorResponse, parseSlackAdvisorResponse, renderWorkspaceToolsNote } from "@owl/shared";
import type { AdvisorTurnRequest, CoreDatabase, CoreWriteLaneTransaction, GitGateway } from "./types";
import type { AdvisorSession, AdvisorSessionManager } from "./advisor-session";
import type { MemorySaver } from "./memory-saver";
import { resolveAdvisorWorkingDirectory } from "./advisor-working-directory";
import { appendAdvisorProjectCatalog } from "./advisor-project-context";
import { ADVISOR_TEXT, formatAdvisorRateLimitReply } from "./advisor-text";
import { ownerLanguage, type OwnerLanguage } from "./owner-language";
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
  RateLimitInfo,
  WebResearchCapture,
} from "@owl/shared";

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
  readonly providerClient: ProviderClient;
  readonly owlRoot: string;
  readonly git?: GitGateway;
  readonly getAdvisorSettings: () => AdvisorSettingsSnapshot;
  readonly isProviderPaused?: (provider: string) => boolean;
  readonly onProviderRateLimited?: (provider: string, rateLimit: RateLimitInfo) => Promise<{ readonly resume_at: string | null }>;
  readonly onProviderSucceeded?: (provider: string, runStartedAt: string) => Promise<void>;
  /** Advisor WebFetch / WebSearch results; recording failures never affect the turn. */
  readonly onWebResearch?: (
    capture: WebResearchCapture,
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
  readonly onReply: (
    conversationId: string,
    reply: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
    suggestedActions: readonly AdvisorSuggestedAction[],
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
  usage_json: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const MAX_TURN_RETRIES = 1;

function providerAliases(provider: string): string[] {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") return ["anthropic", "claude"];
  if (normalized === "openai" || normalized === "codex" || normalized === "openai/codex") return ["openai", "codex", "openai/codex"];
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
): { readonly reply: string; readonly suggested_actions: readonly AdvisorSuggestedAction[] } {
  const onMalformedActions = (reason: string): void => {
    console.warn(`[owl-core] Ignoring malformed Advisor owl-actions block (${reason}); keeping reply text.`);
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
    return { reply: ADVISOR_TEXT[language].emptyReply, suggested_actions: [] };
  }
  return parsed;
}

/**
 * Orchestrates one persistent Advisor ProviderSession: (re)creating it via
 * AdvisorSessionManager + ProviderClient.createSession, running a FIFO queue
 * of turns against it (advisor_turns), and reacting to the SessionEvent
 * stream (turn completion/failure, compaction, process exit).
 *
 * Only one Advisor session is active system-wide at a time (mirrors
 * AdvisorSessionManager.startSession's global "one active session" guard),
 * so a single activeDriver/activeSessionId/turnLoopRunning trio is enough;
 * there is no per-session map.
 */
export class AdvisorSessionRuntime {
  private readonly config: AdvisorRuntimeConfig;
  private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  private readonly pendingTurnPayloads = new Map<string, AdvisorTurnRequest>();
  private activeDriver: ProviderSession | null = null;
  private activeSessionId: string | null = null;
  private activeSystemPrompt: string | null = null;
  private readonly workspaceWasDirty = new Map<string, boolean>();
  private turnLoopRunning = false;
  /** Set when startTurnLoop is called while the loop is already running; the loop switches to this session once its current queue drains. */
  private turnLoopKick: string | null = null;
  private stopped = false;
  /** Serializes ensureSession/stop so concurrent callers never race to create two provider processes for the single owner-wide session. */
  private sessionLock: Promise<void> = Promise.resolve();

  public constructor(config: AdvisorRuntimeConfig) {
    this.config = config;
    this.writeLane = config.db.createWriteLane();
  }

  /** Chains `fn` after every call already queued on the session lock; a rejection never blocks callers queued behind it. */
  private withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sessionLock.then(fn, fn);
    this.sessionLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Returns the Advisor session to send the next turn against, (re)creating
   * or resuming the provider process as needed:
   *   - an already-running session whose driver this runtime still holds,
   *     and whose model/provider match current settings, is reused as-is,
   *     regardless of which interface conversation supplied the turn;
   *   - a suspended session is resumed via provider_session_id;
   *   - anything else unreusable (model drift, a DB-active session this
   *     process holds no live driver for, or a held driver whose process
   *     already exited while idle) is ended and replaced, carrying forward a
   *     context-bridge pointer to the old transcript/workspace.
   */
  public ensureSession(ownerId: string, conversationId: string): Promise<AdvisorSession> {
    return this.withSessionLock(() => this.ensureSessionUnlocked(ownerId, conversationId));
  }

  private async ensureSessionUnlocked(ownerId: string, conversationId: string): Promise<AdvisorSession> {
    const settings = this.config.getAdvisorSettings();
    const active = this.config.sessionManager.getActiveSession(ownerId);

    if (active === null) {
      return this.createSession(ownerId, conversationId, settings, null);
    }

    const modelDrifted =
      active.provider_id !== null &&
      active.model !== null &&
      (active.provider_id !== settings.providerId || active.model !== settings.model);
    const effortDrifted = active.effort !== (settings.effort ?? null);
    const systemPromptDrifted = this.activeSystemPrompt !== null && this.activeSystemPrompt !== settings.systemPrompt;
    if (
      !modelDrifted &&
      !effortDrifted &&
      !systemPromptDrifted &&
      active.status === "running" &&
      this.activeDriver !== null &&
      this.activeDriver.exited !== true &&
      this.activeSessionId === active.id
    ) {
      return active;
    }

    if (!modelDrifted && !effortDrifted && active.status === "suspended") {
      // AdvisorSession is owner-wide and shared by Web, Slack, Discord, and
      // terminal turns. Its workspace is selected when the session starts;
      // switching the source conversation must not fork its provider context
      // or move the resumed process to another conversation's worktree.
      const workspacePath = active.workspace_path
        ? resolve(active.workspace_path)
        : await this.buildWorkingDirectory(active.conversation_id);
      return this.resumeSession(active, settings, workspacePath);
    }

    // Model changed, or the DB says starting/running/ending but this process
    // holds no live driver for it (a crash or restart this instance never
    // observed session.exited for, or a driver that exited while idle; its
    // session.exited is only consumed while a turn is in flight). None is
    // reusable: stop what remains (stop() on an exited driver returns once
    // its process is gone) and start fresh, bridging the prior
    // transcript/workspace as context.
    await this.stopSession(
      active.id,
      modelDrifted ? "model_changed" : effortDrifted || systemPromptDrifted ? "owner_requested" : "crashed",
    );
    const bridgeSource = active.transcript_path ?? active.workspace_path ?? null;
    const replacement = await this.createSession(ownerId, conversationId, settings, bridgeSource);
    if (replacement.id !== active.id) {
      // Turns queued on the replaced session must move to the replacement, or
      // the turn loop (which follows activeSessionId) will never see them.
      await this.moveTurnsToSession(active.id, replacement.id, null);
    }
    return replacement;
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
   * Stops the driver for `sessionId` (if this runtime currently holds it)
   * and records the outcome on the session: "idle_timeout" suspends the
   * logical session for a later resume, everything else ends it outright.
   * The conversation-scoped workspace is independent and is never removed
   * here; pending changes are reported before an ended session is forgotten.
   */
  public async stopSession(sessionId: string, reason: string): Promise<void> {
    if (this.activeSessionId === sessionId && this.activeDriver !== null) {
      const driver = this.activeDriver;
      this.activeDriver = null;
      this.activeSessionId = null;
      this.activeSystemPrompt = null;
      await driver.stop(reason);
    }
    if (reason === "idle_timeout") {
      await this.config.sessionManager.suspendSession(sessionId);
    } else {
      await this.config.sessionManager.endSession(sessionId, reason);
      await this.notifyRetainedWorkspace(sessionId);
    }
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
        const session = await this.ensureSession(conversation.owner_id, turn.conversation_id);
        sessionId = session.id;
      } catch (error) {
        const message = error instanceof Error && error.message.length > 0
          ? error.message
          : "Advisor session could not be resumed after restart.";
        await this.failTurn(turn, message);
        continue;
      }

      await this.enqueueTurnMutation("requeued", { turn_id: turn.id }, (transaction) => {
        transaction.run(
          `UPDATE advisor_turns
              SET session_id = ?, status = 'queued', retry_count = retry_count + 1,
                  started_at = NULL, completed_at = NULL, error = NULL
            WHERE id = ? AND status = 'interrupted'`,
          sessionId,
          turn.id,
        );
      });
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
    if (this.turnLoopRunning) return;
    await this.restartQueuedTurns(null, "after a model change");
  }

  private async restartQueuedTurns(providers: readonly string[] | null, label: string): Promise<void> {
    const session = this.config.db.get<{ id: string; owner_id: string; conversation_id: string }>(
      `SELECT session.id, conversation.owner_id, session.conversation_id
         FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
        WHERE ${providers ? `session.provider_id IN (${providers.map(() => "?").join(",")}) AND ` : ""}session.status IN ('running', 'suspended')
          AND EXISTS (SELECT 1 FROM advisor_turns WHERE session_id = session.id AND status = 'queued')
        ORDER BY session.created_at DESC LIMIT 1`,
      ...(providers ?? []),
    );
    if (!session) return;
    try {
      const active = await this.ensureSession(session.owner_id, session.conversation_id);
      void this.startTurnLoop(active.id).catch((error) => console.error(`[owl-core] Advisor provider resume failed for ${active.id}`, error));
    } catch (error) {
      console.error(`[owl-core] Could not resume queued Advisor turns ${label}`, error);
    }
  }

  /** Core shutdown: stop the child process only. DB status reconciliation (running -> suspended) is Core startup's job (AdvisorSessionManager.recoverOnStartup), not this call's. */
  public stop(): Promise<void> {
    return this.withSessionLock(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<void> {
    this.stopped = true;
    if (this.activeDriver !== null) {
      const driver = this.activeDriver;
      this.activeDriver = null;
      this.activeSessionId = null;
      this.activeSystemPrompt = null;
      await driver.stop("core_shutdown");
    }
  }

  /** End the owned provider process group without waiting for a turn to finish. */
  public stopImmediately(): void {
    this.stopped = true;
    if (this.activeDriver === null) return;
    const driver = this.activeDriver;
    this.activeDriver = null;
    this.activeSessionId = null;
    this.activeSystemPrompt = null;
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
    ownerId: string,
    conversationId: string,
    settings: AdvisorSettingsSnapshot,
    contextBridgeSource: string | null,
  ): Promise<AdvisorSession> {
    const createProviderSession = this.requireSessionSupport();
    const workspacePath = await this.buildWorkingDirectory(conversationId);
    const session = await this.config.sessionManager.startSession(ownerId, conversationId);

    let driver: ProviderSession;
    try {
      driver = await createProviderSession({
        adapter: settings.harnessId,
        role: "advisor",
        model: settings.model,
        effort: settings.effort,
        cwd: workspacePath,
        env: this.buildChildEnv(session.id, workspacePath, settings.connectionEnv),
        system_prompt: this.systemPromptFor(settings, workspacePath),
      });
    } catch (error) {
      await this.config.sessionManager.endSession(session.id, "spawn_failed");
      throw error;
    }

    await this.config.sessionManager.activateSession(session.id, driver.pid, driver.provider_session_id);
    await this.config.sessionManager.setProviderConfig(session.id, {
      providerId: settings.providerId,
      harnessId: settings.harnessId,
      model: settings.model,
      effort: settings.effort ?? null,
    });
    await this.config.sessionManager.setWorkspace(session.id, workspacePath);
    if (contextBridgeSource !== null) {
      await this.config.sessionManager.setContextBridge(session.id, contextBridgeSource);
    }

    this.activeDriver = driver;
    this.activeSessionId = session.id;
    this.activeSystemPrompt = settings.systemPrompt;
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
      context_bridge_source: contextBridgeSource,
    };
  }

  /**
   * Reclaims workspaces/branches a replaced or conversation-switched session
   * left behind (GitGateway.sweepAdvisorWorkspaces), queued behind this
   * runtime's session lock so it can never race a concurrent
   * ensureSession/stop call into removing the workspace one of them is about
   * to use. Never awaited by a caller: a sweep failure is logged and never
   * delays or fails a turn or Core startup.
   */
  public sweepWorkspaces(): Promise<void> {
    const git = this.config.git;
    const sweep = git?.sweepAdvisorWorkspaces;
    if (!git || !sweep) return Promise.resolve();
    return this.withSessionLock(() =>
      sweep.call(git).then(
        () => undefined,
        (error: unknown) => console.error("[owl-core] Advisor workspace sweep failed", error),
      ),
    );
  }

  private sweepAdvisorWorkspacesInBackground(): void {
    void this.sweepWorkspaces();
  }

  private async resumeSession(session: AdvisorSession, settings: AdvisorSettingsSnapshot, workspacePath: string): Promise<AdvisorSession> {
    const createProviderSession = this.requireSessionSupport();

    try {
      // ensureSessionUnlocked only resumes (rather than replacing) a session
      // whose stored provider_id is null or already equal to
      // settings.providerId (a mismatch is "model drifted" and goes through
      // createSession instead), so settings.connectionEnv - resolved for
      // settings.providerId - is always the session's own connection env too.
      const driver = await createProviderSession({
        adapter: session.harness_id ?? settings.harnessId,
        role: "advisor",
        model: session.model ?? settings.model,
        effort: session.effort ?? settings.effort,
        cwd: workspacePath,
        env: this.buildChildEnv(session.id, workspacePath, settings.connectionEnv),
        system_prompt: this.systemPromptFor(settings, workspacePath),
        provider_session_id: session.provider_session_id ?? undefined,
      });
      await this.config.sessionManager.resumeSession(session.id, driver.pid, driver.provider_session_id);
      await this.config.sessionManager.setWorkspace(session.id, workspacePath);
      this.activeDriver = driver;
      this.activeSessionId = session.id;
      this.activeSystemPrompt = settings.systemPrompt;
      void this.startTurnLoop(session.id).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${session.id}`, error));
      return {
        ...session,
        status: "running",
        pid: driver.pid,
        provider_session_id: driver.provider_session_id,
        workspace_path: workspacePath,
      };
    } catch (error) {
      await this.config.sessionManager.endSession(session.id, "resume_failed");
      // The provider cannot resume with the current settings (e.g. a changed
      // system prompt): start a fresh session that bridges the old transcript.
      if (isProviderResumeUnsupportedError(error)) {
        return this.createSession(session.owner_id, session.conversation_id, settings, session.transcript_path ?? session.workspace_path ?? null);
      }
      throw error;
    }
  }

  private requireSessionSupport(): (request: ProviderSessionRequest) => Promise<ProviderSession> {
    const createProviderSession = this.config.providerClient.createSession;
    if (!createProviderSession) {
      throw new Error("Advisor requires a provider with session support");
    }
    return createProviderSession.bind(this.config.providerClient);
  }

  private async buildWorkingDirectory(conversationId: string): Promise<string> {
    if (this.config.git) {
      if (!this.config.git.prepareAdvisorWorkspace) {
        throw new Error("The configured Git gateway does not support isolated Advisor workspaces.");
      }
      const prepared = await this.config.git.prepareAdvisorWorkspace({ conversation_id: conversationId });
      if (!prepared.ok || !prepared.worktree_path) {
        throw new Error(`Advisor worktree could not be prepared: ${prepared.message}`);
      }
      return resolve(prepared.worktree_path);
    }
    return resolveAdvisorWorkingDirectory(this.config.db, this.config.owlRoot, conversationId);
  }

  /**
   * The system prompt actually sent to the provider for one session start:
   * settings.systemPrompt plus a workspace-tools note, appended only when
   * the workspace is a real Project git worktree (prepareAdvisorWorkspace
   * configured), not the plain fallback directory. Kept separate from
   * settings.systemPrompt itself so a workspace change alone never counts as
   * the system-prompt drift that forces a session restart.
   */
  private systemPromptFor(settings: AdvisorSettingsSnapshot, workspacePath: string): string {
    if (!this.config.git?.prepareAdvisorWorkspace) return settings.systemPrompt;
    const note = renderWorkspaceToolsNote(workspacePath);
    if (!note) return settings.systemPrompt;
    return `${settings.systemPrompt}\n\n${["## Workspace tools", ...note].join("\n")}`;
  }

  private async includeWorkspaceNotice(conversationId: string, sessionId: string, reply: string): Promise<string> {
    const notice = await this.getWorkspaceNotice(conversationId, sessionId);
    return notice ? `${reply.trimEnd()}\n\n${notice}` : reply;
  }

  private async getWorkspaceNotice(conversationId: string, sessionId: string): Promise<string | null> {
    const inspect = this.config.git?.inspectAdvisorWorkspace;
    if (!inspect) return null;
    const session = this.config.db.get<{ workspace_path: string | null }>(
      "SELECT workspace_path FROM advisor_sessions WHERE id = ?",
      sessionId,
    );
    if (!session?.workspace_path) return null;
    try {
      const status = await inspect.call(this.config.git, {
        conversation_id: conversationId,
        workspace_path: session.workspace_path,
      });
      if (!status.ok) {
        console.warn(`[owl-core] Could not inspect Advisor workspace for ${conversationId}: ${status.message}`);
        return null;
      }
      const previouslyDirty = this.workspaceWasDirty.get(conversationId) ?? false;
      this.workspaceWasDirty.set(conversationId, status.dirty);
      if (!status.dirty || previouslyDirty) return null;
      return ADVISOR_TEXT[ownerLanguage(this.config.db)].dirtyWorkspace(session.workspace_path);
    } catch (error) {
      console.warn(`[owl-core] Could not inspect Advisor workspace for ${conversationId}`, error);
      return null;
    }
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

  /**
   * The Advisor identity plus, for a custom provider, its endpoint/key
   * travel on the session request. The provider owns the base agent
   * environment, which excludes Owl's own credentials; OWL_AGENT_* is set
   * last so a custom provider's env can never shadow the agent identity.
   */
  private buildChildEnv(sessionId: string, cwd: string, connectionEnv: Readonly<Record<string, string>> | undefined): Record<string, string> {
    return {
      ...(connectionEnv ?? {}),
      OWL_AGENT_ROLE: "advisor",
      OWL_AGENT_RUN_ID: sessionId,
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
    if (this.turnLoopRunning) {
      // The loop is busy draining another session's queue; ask it to switch
      // to this one once that queue is empty instead of starting a second
      // loop (there is only ever one turn loop system-wide).
      this.turnLoopKick = sessionId;
      return Promise.resolve();
    }
    this.turnLoopRunning = true;
    return this.runTurnLoop(sessionId);
  }

  private async runTurnLoop(initialSessionId: string): Promise<void> {
    let sessionId = initialSessionId;
    try {
      for (;;) {
        // Re-read the current active session on every iteration: ensureSession
        // may have replaced it (model change, crash recovery) while this loop
        // was mid-turn, and the queue now lives under the new session id.
        const targetSessionId = this.activeSessionId ?? sessionId;
        if (this.config.isProviderPaused?.(this.advisorProviderId(targetSessionId))) return;
        const turnRow = this.dequeueOldestQueuedTurn(targetSessionId);
        if (!turnRow) {
          if (this.turnLoopKick !== null) {
            sessionId = this.turnLoopKick;
            this.turnLoopKick = null;
            continue;
          }
          return;
        }
        try {
          // A send failure may move the turn (and the rest of the queue) to a
          // replacement session; keep draining whichever session it ended on.
          sessionId = await this.processTurn(targetSessionId, turnRow);
        } catch (error) {
          const message = error instanceof Error && error.message.length > 0
            ? error.message
            : ADVISOR_TEXT[ownerLanguage(this.config.db)].turnFailed;
          await this.failTurn(turnRow, message);
        }
      }
    } finally {
      this.turnLoopRunning = false;
      if (this.turnLoopKick !== null && !this.stopped) {
        const kicked = this.turnLoopKick;
        this.turnLoopKick = null;
        void this.startTurnLoop(kicked).catch((error) => console.error(`[owl-core] Advisor turn loop failed for ${kicked}`, error));
      }
    }
  }

  private dequeueOldestQueuedTurn(sessionId: string): AdvisorTurnRow | undefined {
    return this.config.db.get<AdvisorTurnRow>(
      `SELECT * FROM advisor_turns WHERE session_id = ? AND status = 'queued' ORDER BY queued_at ASC LIMIT 1`,
      sessionId,
    );
  }

  /**
   * Sends one turn and waits for it to settle. Returns the session the turn
   * ended on: normally `sessionId`, or the replacement session when the send
   * failed and was retried once on a fresh driver.
   */
  private async processTurn(sessionId: string, turnRow: AdvisorTurnRow): Promise<string> {
    await this.markTurnRunning(turnRow.id);
    await this.config.sessionManager.recordActivity(sessionId);

    const turnRequest = this.loadTurnRequest(turnRow);
    this.pendingTurnPayloads.delete(turnRow.id);

    const driver = this.activeDriver;
    if (!driver || this.activeSessionId !== sessionId) {
      const message = "The advisor session process is not running.";
      await this.failTurn(turnRow, message);
      return sessionId;
    }

    const payload = {
      turn_id: turnRequest.turn_id,
      text: applyAdvisorInterfaceInstructions(
        appendAdvisorProjectCatalog(turnRequest.text, this.config.db),
        turnRequest.origin.channel,
      ),
      attachment_paths: turnRequest.attachment_paths,
    };

    try {
      if (driver.exited === true) {
        throw new Error("The advisor session process has already exited.");
      }
      await driver.send(payload);
    } catch (error) {
      const recovered = await this.retrySendOnFreshSession(sessionId, turnRow, driver, payload, error);
      if (recovered.driver === null) {
        return recovered.sessionId;
      }
      await this.consumeUntilTurnSettles(recovered.sessionId, turnRow, recovered.driver);
      return recovered.sessionId;
    }

    await this.consumeUntilTurnSettles(sessionId, turnRow, driver);
    return sessionId;
  }

  /** Stops a driver that can no longer take turns and forgets it, so the next ensureSession replaces it. */
  private async discardDriver(driver: ProviderSession, reason: string): Promise<void> {
    if (this.activeDriver === driver) {
      this.activeDriver = null;
      this.activeSessionId = null;
      this.activeSystemPrompt = null;
    }
    try {
      await driver.stop(reason);
    } catch (error) {
      console.warn(`[owl-core] Could not stop the discarded Advisor driver (${reason})`, error);
    }
  }

  /**
   * A send failure means the held driver is dead or unusable (for example it
   * exited while idle). Discard it, obtain a replacement session through
   * ensureSession (the crash path: end + context bridge + fresh driver) and
   * resend exactly once. The turn is failed when that also fails. Returns
   * the session the queue now lives on and, on success, the driver to
   * consume the turn's events from.
   */
  private async retrySendOnFreshSession(
    sessionId: string,
    turnRow: AdvisorTurnRow,
    driver: ProviderSession,
    payload: Parameters<ProviderSession["send"]>[0],
    sendError: unknown,
  ): Promise<{ readonly sessionId: string; readonly driver: ProviderSession | null }> {
    const sendMessage = sendError instanceof Error && sendError.message.length > 0 ? sendError.message : String(sendError);
    await this.discardDriver(driver, "send_failed");
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
    const freshDriver = this.activeDriver;
    if (freshDriver === null || this.activeSessionId !== freshSession.id) {
      await this.failTurn(turnRow, sendMessage);
      return { sessionId, driver: null };
    }
    if (freshSession.id !== sessionId) {
      await this.moveTurnsToSession(sessionId, freshSession.id, turnRow.id);
    }

    try {
      await freshDriver.send(payload);
    } catch (error) {
      await this.discardDriver(freshDriver, "send_failed");
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
    const message = this.config.db.get<{ body: string }>(
      `SELECT body FROM messages WHERE id = ?`,
      turnRow.user_message_id,
    );
    if (!message || typeof message.body !== "string" || message.body.trim().length === 0) {
      throw new Error(`Advisor turn ${turnRow.id} references a missing or empty user message.`);
    }
    const { paths: attachmentPaths, notes } = this.config.resolveAttachmentPaths(turnRow.user_message_id);
    return {
      turn_id: turnRow.id,
      text: notes.length > 0 ? `${message.body}\n\n${notes.join("\n")}` : message.body,
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
    sessionId: string,
    turnRow: AdvisorTurnRow,
    driver: ProviderSession,
  ): Promise<void> {
    const iterator = driver.events()[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done || step.value === undefined) {
        const message = "The advisor session ended without completing this turn.";
        await this.failTurn(turnRow, message);
        return;
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

        case "turn.completed": {
          if (event.turn_id !== turnRow.id) {
            break;
          }
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
          );
          await this.markTurnCompleted(turnRow.id, usageJson, replyMessageId);
          const startedAt = this.config.db.get<{ started_at: string | null }>(
            `SELECT started_at FROM advisor_turns WHERE id = ?`, turnRow.id,
          )?.started_at;
          const sessionProvider = this.config.db.get<{ provider_id: string | null }>(
            `SELECT provider_id FROM advisor_sessions WHERE id = ?`, sessionId,
          )?.provider_id;
          if (sessionProvider && startedAt) await this.config.onProviderSucceeded?.(sessionProvider, startedAt);
          return;
        }

        case "turn.failed": {
          if (event.turn_id !== turnRow.id) {
            break;
          }
          const rateLimit = rateLimitInfoFromEvent(event);
          if (rateLimit !== null) {
            await this.failRateLimitedTurn(sessionId, turnRow, event.error, rateLimit);
          } else {
            await this.failTurn(turnRow, event.error);
          }
          return;
        }

        case "session.compacted":
          await this.handleCompaction(sessionId, turnRow.conversation_id, event);
          break;

        case "session.exited": {
          // Core shutdown deliberately leaves running turns for
          // recoverTurns() to retry after the new Core resumes the session.
          // The driver's SIGTERM exit event is expected during that shutdown.
          if (this.stopped) {
            return;
          }
          if (this.activeSessionId === sessionId) {
            this.activeDriver = null;
            this.activeSessionId = null;
            this.activeSystemPrompt = null;
          }
          await this.config.sessionManager.suspendSession(sessionId);
          const message = event.stderr_tail.length > 0
            ? event.stderr_tail
            : `The advisor session process exited unexpectedly (exit_code=${String(event.exit_code)}, signal=${String(event.signal)}).`;
          await this.failTurn(turnRow, message);
          return;
        }

        default:
          break;
      }
    }
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

    const { path, captured } = await this.config.memorySaver.saveCompactionSummary(sessionId, {
      conversationId,
      cause: event.cause,
      preTokens: event.pre_tokens,
      summary: event.summary,
      provider: sessionRow?.provider_id ?? "unknown",
      model: sessionRow?.model ?? "unknown",
      index: (sessionRow?.compaction_count ?? 0) + 1,
      transcriptPath: event.transcript_path,
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

  private markTurnFailed(turnId: string, errorMessage: string): Promise<void> {
    const now = utcNow();
    return this.enqueueTurnMutation("turn_failed", { turn_id: turnId }, (transaction) => {
      transaction.run(
        `UPDATE advisor_turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
        now,
        errorMessage,
        turnId,
      );
    });
  }

  private async failTurn(turnRow: AdvisorTurnRow, errorMessage: string): Promise<void> {
    const current = this.config.db.get<{ status: AdvisorTurnStatus }>(
      `SELECT status FROM advisor_turns WHERE id = ?`,
      turnRow.id,
    );
    if (!current || current.status === "completed" || current.status === "failed") {
      return;
    }
    await this.markTurnFailed(turnRow.id, errorMessage);
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
  ): Promise<void> {
    const current = this.config.db.get<{ status: AdvisorTurnStatus }>(
      `SELECT status FROM advisor_turns WHERE id = ?`,
      turnRow.id,
    );
    if (!current || current.status === "completed" || current.status === "failed") return;

    // Mark the turn failed before any reply work so a restart cannot resend
    // this same request after a rate-limit response.
    await this.markTurnFailed(turnRow.id, errorMessage);

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

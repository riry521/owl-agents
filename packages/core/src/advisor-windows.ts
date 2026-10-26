import { createUlid } from "../../db/dist/index.js";
import {
  GENERAL_WINDOW_KEY,
  type AdvisorWindowChannel,
  type AdvisorWindowScope,
  type AdvisorWindowSessionStatus,
  type AdvisorWindowSummary,
} from "../../shared/dist/advisor-windows.js";
import { ensureOwner } from "./state-reducer";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

export interface AdvisorWindowRef {
  readonly window_id: string;
  readonly conversation_id: string;
}

interface WindowRow extends AdvisorWindowRef {
  readonly scope: AdvisorWindowScope;
  readonly project_id: string | null;
}

/** The web connector account every web-origin message is attributed to. */
export function ensureWebAccount(transaction: CoreWriteLaneTransaction, ownerId: string, now: string): { id: string } {
  const existing = transaction.get<{ id: string }>("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId);
  if (existing) return existing;
  const id = createUlid();
  transaction.run(
    "INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', 'web-default', ?)",
    id, ownerId, now,
  );
  return { id };
}

/** The Owner's general window; created on first use from the existing active web conversation, or a new one. */
export function ensureGeneralWindowInTransaction(transaction: CoreWriteLaneTransaction, ownerId: string, now: string): AdvisorWindowRef {
  const existing = transaction.get<AdvisorWindowRef>(
    "SELECT id AS window_id, conversation_id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'",
    ownerId,
  );
  // A migrated Owner may have the window but no web account (Slack-only history), so web posts need it on every path.
  if (existing) {
    ensureWebAccount(transaction, ownerId, now);
    return existing;
  }
  ensureOwner(transaction, ownerId, now);
  ensureWebAccount(transaction, ownerId, now);
  let conversationId = transaction.get<{ id: string }>(
    `SELECT id FROM conversations
      WHERE owner_id = ? AND channel = 'web' AND is_active = 1 AND archived_at IS NULL AND work_id IS NULL
      ORDER BY updated_at DESC LIMIT 1`,
    ownerId,
  )?.id;
  if (!conversationId) {
    conversationId = createUlid();
    transaction.run(
      "INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)",
      conversationId, ownerId, now, now,
    );
  }
  const windowId = createUlid();
  transaction.run(
    "INSERT INTO advisor_windows (id, owner_id, scope, project_id, conversation_id, created_at, updated_at) VALUES (?, ?, 'general', NULL, ?, ?, ?)",
    windowId, ownerId, conversationId, now, now,
  );
  transaction.run(
    "UPDATE conversations SET advisor_window_id = ? WHERE owner_id = ? AND work_id IS NULL AND advisor_window_id IS NULL AND archived_at IS NULL",
    windowId, ownerId,
  );
  return { window_id: windowId, conversation_id: conversationId };
}

/** The Owner's window for a Project; created on first use with an inactive web conversation so the general lookups never pick it. */
export function ensureProjectWindowInTransaction(transaction: CoreWriteLaneTransaction, ownerId: string, projectId: string, now: string): AdvisorWindowRef {
  const existing = transaction.get<AdvisorWindowRef>(
    "SELECT id AS window_id, conversation_id FROM advisor_windows WHERE owner_id = ? AND scope = 'project' AND project_id = ?",
    ownerId, projectId,
  );
  if (existing) {
    ensureWebAccount(transaction, ownerId, now);
    return existing;
  }
  ensureOwner(transaction, ownerId, now);
  ensureWebAccount(transaction, ownerId, now);
  const windowId = createUlid();
  const conversationId = createUlid();
  transaction.run(
    "INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 0, ?, ?)",
    conversationId, ownerId, now, now,
  );
  transaction.run(
    "INSERT INTO advisor_windows (id, owner_id, scope, project_id, conversation_id, created_at, updated_at) VALUES (?, ?, 'project', ?, ?, ?, ?)",
    windowId, ownerId, projectId, conversationId, now, now,
  );
  transaction.run("UPDATE conversations SET advisor_window_id = ? WHERE id = ?", windowId, conversationId);
  return { window_id: windowId, conversation_id: conversationId };
}

/** Read-only lookup of a window; key is GENERAL_WINDOW_KEY or a Project id. Null when it does not exist yet. */
export function findAdvisorWindow(db: Pick<CoreDatabase, "get">, ownerId: string, key: string): AdvisorWindowRef | null {
  return db.get<AdvisorWindowRef>(
    key === GENERAL_WINDOW_KEY
      ? "SELECT id AS window_id, conversation_id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'"
      : "SELECT id AS window_id, conversation_id FROM advisor_windows WHERE owner_id = ? AND scope = 'project' AND project_id = ?",
    ...(key === GENERAL_WINDOW_KEY ? [ownerId] : [ownerId, key]),
  ) ?? null;
}

/** The window a conversation belongs to, or null for Work conversations and unknown ids. */
export function windowOfConversation(db: Pick<CoreDatabase, "get">, conversationId: string): WindowRow | null {
  return db.get<WindowRow>(
    `SELECT w.id AS window_id, w.conversation_id, w.scope, w.project_id
       FROM conversations c JOIN advisor_windows w ON w.id = c.advisor_window_id
      WHERE c.id = ?`,
    conversationId,
  ) ?? null;
}

const SESSION_STATUS_RANK: readonly AdvisorWindowSessionStatus[] = ["running", "starting", "suspended"];

/** General window first, then the Projects with the window switched on or a channel bound, in the Projects list order, whether or not its window exists yet. */
export function listAdvisorWindows(db: Pick<CoreDatabase, "all" | "get">, ownerId: string): AdvisorWindowSummary[] {
  const windows = db.all<WindowRow & { id: string }>(
    "SELECT id AS window_id, id, conversation_id, scope, project_id FROM advisor_windows WHERE owner_id = ?",
    ownerId,
  );
  const projects = db.all<{ id: string; name: string }>(`SELECT p.id, p.name FROM projects p
      WHERE p.advisor_window_enabled = 1
         OR EXISTS (SELECT 1 FROM advisor_windows w JOIN advisor_channel_bindings b ON b.window_id = w.id WHERE w.project_id = p.id)
      ORDER BY p.id ASC`);
  const bindings = db.all<AdvisorWindowChannel & { window_id: string }>(
    "SELECT window_id, provider, channel_id, display_name FROM advisor_channel_bindings ORDER BY provider",
  );
  const sessions = db.all<{ window_id: string; status: string }>(
    "SELECT window_id, status FROM advisor_sessions WHERE window_id IS NOT NULL AND status IN ('starting', 'running', 'suspended')",
  );
  const summarize = (key: string, scope: AdvisorWindowScope, projectId: string | null, name: string | null, window: WindowRow | undefined): AdvisorWindowSummary => {
    const status = sessions.filter((session) => session.window_id === window?.window_id).map((session) => session.status);
    return {
      key,
      scope,
      project_id: projectId,
      name,
      window_id: window?.window_id ?? null,
      conversation_id: window?.conversation_id ?? null,
      session_status: SESSION_STATUS_RANK.find((rank) => status.includes(rank)) ?? "none",
      channels: bindings.filter((binding) => binding.window_id === window?.window_id)
        .map(({ provider, channel_id, display_name }) => ({ provider, channel_id, display_name })),
      last_message_at: window
        ? db.get<{ at: string | null }>("SELECT MAX(received_at) AS at FROM messages WHERE conversation_id = ?", window.conversation_id)?.at ?? null
        : null,
    };
  };
  return [
    summarize(GENERAL_WINDOW_KEY, "general", null, null, windows.find((window) => window.scope === "general")),
    ...projects.map((project) => summarize(project.id, "project", project.id, project.name, windows.find((window) => window.project_id === project.id))),
  ];
}

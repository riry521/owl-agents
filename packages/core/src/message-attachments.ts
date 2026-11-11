import { existsSync } from "node:fs";
import { join } from "node:path";

import { notFound, validationError } from "./errors";
import type { CoreDatabase, CoreWriteLaneTransaction, MessageAttachment } from "./types";

type Reader = Pick<CoreDatabase, "get" | "all">;

type AttachmentStatus = MessageAttachment["status"];

export type MessageAttachmentView = MessageAttachment;

export interface ResolvedAttachment extends MessageAttachmentView {
  /** Set only for a stored file: the shared-folder copy when it still exists, else the artifact file. */
  readonly path: string | null;
}

interface UploadRow {
  id: string;
  filename: string;
  declared_mime: string | null;
  detected_mime: string | null;
  declared_bytes: number;
  bytes: number | null;
  status: string;
  artifact_path: string | null;
  shared_copy_path: string | null;
}

const UPLOAD_SELECT = `SELECT u.id AS id, u.filename AS filename, u.declared_mime AS declared_mime, u.detected_mime AS detected_mime,
       u.declared_bytes AS declared_bytes, u.bytes AS bytes, u.status AS status,
       u.shared_copy_path AS shared_copy_path, a.path AS artifact_path
  FROM inbound_uploads u LEFT JOIN artifacts a ON a.id = u.artifact_id`;

function toView(row: UploadRow, status: AttachmentStatus): MessageAttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.detected_mime ?? row.declared_mime ?? "application/octet-stream",
    bytes: row.bytes ?? row.declared_bytes,
    status,
  };
}

/** Rejects ids that are missing, belong to another conversation, or are not completed; throws inside the caller's transaction. */
export function assertMessageAttachmentsInTransaction(
  transaction: CoreWriteLaneTransaction,
  conversationId: string,
  attachmentIds: readonly string[],
): readonly { id: string; filename: string; status: AttachmentStatus }[] {
  return attachmentIds.map((id) => {
    const upload = transaction.get<{ conversation_id: string | null; status: string; filename: string }>(
      "SELECT conversation_id, status, filename FROM inbound_uploads WHERE id = ?",
      id,
    );
    if (!upload) throw notFound("inbound_upload", id);
    if (upload.conversation_id !== conversationId) {
      throw validationError("Inbound attachment_ids must belong to the resolved conversation.", { field: "attachment_ids" }, { code: "attachment.not_in_conversation", values: { field: "attachment_ids" } });
    }
    if (upload.status !== "stored" && upload.status !== "quarantined") {
      throw validationError("Inbound attachment_ids must reference a completed upload.", { field: "attachment_ids" }, { code: "attachment.upload_not_completed", values: { field: "attachment_ids" } });
    }
    return { id, filename: upload.filename, status: upload.status };
  });
}

/** Attachments in the given order. An id that is unknown or not completed is left out. */
export function resolveMessageAttachments(db: Reader, owlRoot: string, attachmentIds: readonly string[]): ResolvedAttachment[] {
  const resolved: ResolvedAttachment[] = [];
  for (const id of attachmentIds) {
    const row = db.get<UploadRow>(`${UPLOAD_SELECT} WHERE u.id = ?`, id);
    if (!row || (row.status !== "stored" && row.status !== "quarantined")) continue;
    const path = row.status === "stored" && row.artifact_path
      ? (row.shared_copy_path && existsSync(row.shared_copy_path) ? row.shared_copy_path : join(owlRoot, row.artifact_path))
      : null;
    resolved.push({ ...toView(row, row.status), path });
  }
  return resolved;
}

/** Public attachment views (no paths) keyed by upload id, read in one query. */
export function messageAttachmentViews(db: Reader, attachmentIds: readonly string[]): Map<string, MessageAttachmentView> {
  const views = new Map<string, MessageAttachmentView>();
  const unique = [...new Set(attachmentIds)];
  if (unique.length === 0) return views;
  const rows = db.all<UploadRow>(`${UPLOAD_SELECT} WHERE u.id IN (${unique.map(() => "?").join(", ")})`, ...unique);
  for (const row of rows) {
    if (row.status === "stored" || row.status === "quarantined") views.set(row.id, toView(row, row.status));
  }
  return views;
}

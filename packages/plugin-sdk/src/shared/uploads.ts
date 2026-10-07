import { createHash } from "node:crypto";
import { commandEnvelopeFor, type CoreClient } from "../client";

export interface UploadAttachmentFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Buffer;
}

export interface UploadAttachmentConversationHint {
  readonly work_id: string | null;
  readonly dm_ref: string;
  readonly thread_ref: string | null;
}

export interface UploadAttachmentRequest {
  readonly provider: "slack" | "discord" | "web";
  readonly account_id: string;
  readonly external_attachment_id: string;
  readonly conversation_hint: UploadAttachmentConversationHint;
  readonly work_id: string | null;
  readonly file: UploadAttachmentFile;
}

export interface UploadedAttachment {
  readonly upload_id: string;
  readonly conversation_id: string;
  readonly status: "stored" | "quarantined";
}

/**
 * Hands one attachment to Core through /inbound/uploads (register -> PUT
 * content -> complete) instead of a connector saving it to local disk. The
 * upload_id this returns is meant to be included in the attachment_ids of
 * exactly one /inbound/messages call for the same batch.
 *
 * Idempotent: retrying with the same (provider, account_id,
 * external_attachment_id) replays the same upload_id instead of registering
 * a duplicate, matching Core's own inbound_uploads idempotency contract.
 */
export async function uploadAttachment(
  client: Pick<CoreClient, "request">,
  request: UploadAttachmentRequest,
): Promise<UploadedAttachment> {
  const sha256 = createHash("sha256").update(request.file.bytes).digest("hex");
  const idempotencyKey = `${request.provider}:upload:${request.account_id}:${request.external_attachment_id}`;

  const ticket = await client.request<{ upload_id: string; conversation_id: string }>("/inbound/uploads", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      provider: request.provider,
      account_id: request.account_id,
      external_attachment_id: request.external_attachment_id,
      filename: request.file.name,
      declared_mime: request.file.mime,
      declared_bytes: request.file.bytes.byteLength,
      sha256,
      work_id: request.work_id,
      conversation_id: null,
      conversation_hint: request.conversation_hint,
    },
  });

  await client.request(`/inbound/uploads/${ticket.upload_id}/content`, {
    method: "PUT",
    body: request.file.bytes,
    headers: {
      "Content-Type": request.file.mime,
      "Content-Length": String(request.file.bytes.byteLength),
      Digest: `sha-256=${Buffer.from(sha256, "hex").toString("base64")}`,
    },
  });

  const completed = await client.request<{ upload_id: string; status: "stored" | "quarantined" }>(
    `/inbound/uploads/${ticket.upload_id}/complete`,
    {
      method: "POST",
      body: commandEnvelopeFor({
        payload: { bytes: request.file.bytes.byteLength, sha256, mime: request.file.mime },
        idempotencyKey: `${idempotencyKey}:complete`,
        expectedVersion: 0,
      }),
    },
  );

  return { upload_id: ticket.upload_id, conversation_id: ticket.conversation_id, status: completed.status };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const commandEnvelope = (payload, suffix, expectedVersion) => command(payload, `inbound-upload-attachments:${suffix}`, expectedVersion);
const waitUntil = (predicate, message) => waitFor(predicate, { message });

/** Registers, PUTs content for, and completes one inbound upload end-to-end. */
async function registerPutComplete(core, accountId, { externalAttachmentId, filename, mime, content, conversationHint, conversationId }) {
  const registered = await core.registerInboundUpload(ownerId, commandEnvelope({
    provider: "slack",
    account_id: accountId,
    external_attachment_id: externalAttachmentId,
    filename,
    declared_mime: mime,
    declared_bytes: content.byteLength,
    sha256: null,
    work_id: null,
    conversation_id: conversationId ?? null,
    conversation_hint: conversationHint ?? null,
  }, `register:${externalAttachmentId}`));
  const ticket = registered.data;
  const sha256 = sha256Hex(content);
  await core.putInboundUpload(ownerId, ticket.upload_id, { content, sha256, mime });
  const completed = await core.completeInboundUpload(ownerId, ticket.upload_id, commandEnvelope(
    { bytes: content.byteLength, sha256, mime },
    `complete:${externalAttachmentId}`,
  ));
  return { ticket, completed: completed.data };
}

test("registerInboundUpload resolves a conversation from a hint before the message exists, and ingestInbound wires the stored attachment's path into the Advisor turn while excluding a quarantined one with a note", async (t) => {
  const sentTurns = [];
  let currentTurn;
  let readySent = false;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "inbound-upload-attachments-session",
      pid: process.pid,
      send: async (turn) => {
        currentTurn = turn;
        sentTurns.push(turn);
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield {
              type: "session.ready",
              provider_session_id: "inbound-upload-attachments-session",
              pid: process.pid,
            };
          }
          assert.ok(currentTurn, "the provider should receive a turn before returning its reply");
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: "Acknowledged.", usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("This regression test never creates a Work."); },
    runWorker: async () => { throw new Error("This regression test never runs a Worker."); },
    runReviewer: async () => { throw new Error("This regression test never runs a Reviewer."); },
    runAdvisor: async () => { throw new Error("The persistent provider session should handle Advisor replies."); },
  };

  const { root, db, core } = await createTestCore(t, {
    agentRunner,
    providerClient,
    version: "inbound-upload-attachments-test",
    dispatcher: { tick_interval_ms: 25 },
  });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({
    ok: true,
    dirty: false,
    message: "The regression test Advisor workspace is clean.",
  });
  await core.start();
  // Advisor replies and errors are always persisted through the owner's
  // default 'web' connector account (the UI channel), independent of the
  // origin channel of the message that triggered the turn. Bootstrap it
  // the same way the server does on first use, so the completed turn
  // below can actually be persisted.
  await core.getActiveConversation();

  const accountId = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", accountId);

  const conversationHint = { work_id: null, dm_ref: "attachments-e2e", thread_ref: null };
  const reportContent = Buffer.from("Please review the attached report.\n", "utf8");
  const scriptContent = Buffer.from("#!/bin/sh\necho hi\n", "utf8");

  const stored = await registerPutComplete(core, accountId, {
    externalAttachmentId: "att-report",
    filename: "report.txt",
    mime: "text/plain",
    content: reportContent,
    conversationHint,
  });
  assert.equal(stored.completed.status, "stored");

  const quarantined = await registerPutComplete(core, accountId, {
    externalAttachmentId: "att-script",
    filename: "malware.sh",
    mime: "text/x-shellscript",
    content: scriptContent,
    conversationHint,
  });
  assert.equal(quarantined.completed.status, "quarantined");
  assert.equal(
    quarantined.ticket.conversation_id,
    stored.ticket.conversation_id,
    "the same conversation_hint must resolve to the same conversation across separate uploads",
  );

  const artifactRow = db.get("SELECT path FROM artifacts WHERE id = ?", stored.completed.artifact_id);
  assert.ok(artifactRow, "the stored upload must have an artifact row");
  const expectedPath = join(root, artifactRow.path);

  const ingested = await core.ingestInbound(ownerId, commandEnvelope({
    provider: "slack",
    account_id: accountId,
    external_message_id: "msg-with-attachments",
    user_id: "U1",
    channel_id: "attachments-e2e",
    thread_id: null,
    received_at: new Date().toISOString(),
    text: "See attached.",
    conversation_hint: conversationHint,
    attachment_ids: [stored.ticket.upload_id, quarantined.ticket.upload_id],
  }, "ingest-with-attachments"));
  assert.equal(ingested.data.status, "accepted");
  assert.equal(ingested.data.conversation_id, stored.ticket.conversation_id);

  await waitUntil(
    () => {
      const row = db.get(
        "SELECT status FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1",
        ingested.data.conversation_id,
      );
      return row?.status === "completed" ? row : null;
    },
    "the Advisor turn dispatched for the message with attachments to complete",
  );
  assert.equal(sentTurns.length, 1);
  const turn = sentTurns[0];
  assert.deepEqual(
    turn.attachment_paths,
    [expectedPath],
    "only the stored attachment's absolute path should reach the Advisor, not the quarantined one",
  );
  assert.ok(turn.text.startsWith("See attached."), "the original message text must lead the turn text");
  assert.match(turn.text, /malware\.sh/u, "the quarantine note must name the excluded file");
  const tagged = /^See attached\.\n\n<owl-attachment-notes>(.*?)<\/owl-attachment-notes>/su.exec(turn.text);
  assert.ok(tagged, "notes must sit in one tag after the untouched message text");
  const notes = JSON.parse(tagged[1]);
  assert.ok(Array.isArray(notes) && notes.length === 1 && /malware\.sh/u.test(notes[0]), "notes must restore as a JSON array");

  const readBack = await readFile(expectedPath);
  assert.deepEqual(readBack, reportContent, "the resolved attachment path must contain the uploaded bytes");
});

test("registerInboundUpload requires exactly one of conversation_id/conversation_hint, and ingestInbound rejects attachment_ids outside the resolved conversation or not yet completed", async (t) => {
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("This validation test never creates a Work."); },
    runWorker: async () => { throw new Error("This validation test never runs a Worker."); },
    runReviewer: async () => { throw new Error("This validation test never runs a Reviewer."); },
    runAdvisor: async () => { throw new Error("This validation test never dispatches an Advisor turn."); },
  };
  const { core } = await createTestCore(t, {
    agentRunner,
    version: "inbound-upload-validation-test",
    dispatcher: { tick_interval_ms: 25 },
  });

  const accountId = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", accountId);

  const basePayload = {
    provider: "slack",
    account_id: accountId,
    filename: "a.txt",
    declared_mime: "text/plain",
    declared_bytes: 3,
    sha256: null,
    work_id: null,
  };

  await assert.rejects(
    () => core.registerInboundUpload(ownerId, commandEnvelope(
      { ...basePayload, external_attachment_id: "att-validation-both-null", conversation_id: null, conversation_hint: null },
      "both-null",
    )),
    (error) => error?.code === "validation_error",
    "both null must be rejected",
  );

  const hintA = { work_id: null, dm_ref: "validation-a", thread_ref: null };
  await assert.rejects(
    () => core.registerInboundUpload(ownerId, commandEnvelope(
      { ...basePayload, external_attachment_id: "att-validation-both-set", conversation_id: createUlid(), conversation_hint: hintA },
      "both-set",
    )),
    (error) => error?.code === "validation_error",
    "both set must be rejected",
  );

  // A completed upload registered under one conversation_hint must not be
  // usable as an attachment on a message that resolves into another one.
  const contentA = Buffer.from("hello", "utf8");
  const uploadedA = await registerPutComplete(core, accountId, {
    externalAttachmentId: "att-wrong-conversation",
    filename: "a.txt",
    mime: "text/plain",
    content: contentA,
    conversationHint: hintA,
  });
  assert.equal(uploadedA.completed.status, "stored");

  const hintB = { work_id: null, dm_ref: "validation-b", thread_ref: null };
  await assert.rejects(
    () => core.ingestInbound(ownerId, commandEnvelope({
      provider: "slack",
      account_id: accountId,
      external_message_id: "msg-wrong-conversation",
      user_id: "U1",
      channel_id: "validation-b",
      thread_id: null,
      received_at: new Date().toISOString(),
      text: "wrong conversation",
      conversation_hint: hintB,
      attachment_ids: [uploadedA.ticket.upload_id],
    }, "ingest-wrong-conversation")),
    (error) => error?.code === "validation_error" && /belong to the resolved conversation/u.test(error.message),
    "an attachment from a different conversation must be rejected",
  );

  // An upload that has not finished (still 'registered') must not be usable
  // as an attachment yet, even from the same conversation.
  const registeredOnly = await core.registerInboundUpload(ownerId, commandEnvelope(
    { ...basePayload, external_attachment_id: "att-incomplete", conversation_id: null, conversation_hint: hintA },
    "register-incomplete",
  ));

  await assert.rejects(
    () => core.ingestInbound(ownerId, commandEnvelope({
      provider: "slack",
      account_id: accountId,
      external_message_id: "msg-incomplete-attachment",
      user_id: "U1",
      channel_id: "validation-a",
      thread_id: null,
      received_at: new Date().toISOString(),
      text: "incomplete attachment",
      conversation_hint: hintA,
      attachment_ids: [registeredOnly.data.upload_id],
    }, "ingest-incomplete-attachment")),
    (error) => error?.code === "validation_error" && /completed upload/u.test(error.message),
    "an attachment still in 'registered' status must be rejected",
  );
});

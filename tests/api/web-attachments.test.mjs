import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { MAX_MESSAGE_ATTACHMENTS, MAX_UPLOAD_BYTES } from "../../packages/core/dist/upload-limits.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const idle = async () => ({ outcome: "failed" });

async function startAdapterServer(t) {
  const { root, db, core } = await createTestCore(t, {
    version: "api-web-attachments-test",
    dispatcher: { tick_interval_ms: 60_000 },
    agentRunner: { runManagerPlan: idle, runWorker: idle, runReviewer: idle, runAdvisor: async () => ({ reply: "" }) },
  }, { prefix: "owl-api-web-attachments-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root, dataDir }, { token: "owner-token" });
  if (!api) {
    t.skip("localhost listen is unavailable");
    return null;
  }
  return { api, core, db };
}

const authHeaders = { authorization: "Bearer owner-token" };

function upload(api, scope, id, { name = "note.txt", body = "hello", key = "k1", mime = "text/plain", extra = {} } = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return fetch(`${api.baseUrl}/api/v1/${scope}/${id}/attachments`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": mime,
      "x-owl-filename": encodeURIComponent(name),
      "x-request-id": `req-${key}`,
      "idempotency-key": key,
      ...extra,
    },
    body: content,
  });
}

let sequence = 0;
function postJson(api, route, payload) {
  sequence += 1;
  return fetch(`${api.baseUrl}${route}`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ request_id: `req-msg-${sequence}`, idempotency_key: `msg-${sequence}`, expected_version: 0, payload }),
  });
}

async function runningWork(core, db) {
  const created = await core.createWork(command({ title: "Attach", summary: "", size: "small", project_id: null }, "attach-work"));
  const id = created.data.work_id;
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'running', state_version = 1, updated_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", id);
  });
  return id;
}

test("GET /uploads/limits returns the shared limits", async (t) => {
  const server = await startAdapterServer(t);
  if (!server) return;
  const response = await fetch(`${server.api.baseUrl}/api/v1/uploads/limits`, { headers: authHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { max_bytes: MAX_UPLOAD_BYTES, max_files: MAX_MESSAGE_ATTACHMENTS });
});

test("conversation attachments: upload returns 201 with the inbound_uploads id, and text+file, file-only and text-only messages are each stored once", async (t) => {
  const server = await startAdapterServer(t);
  if (!server) return;
  const { api, core, db } = server;
  const { conversation_id: conversationId } = await core.getActiveConversation();

  const first = await upload(api, "conversations", conversationId, { key: "u1" });
  assert.equal(first.status, 201);
  const uploaded = (await first.json()).data;
  assert.equal(uploaded.status, "stored");
  assert.equal(uploaded.filename, "note.txt");
  assert.equal(db.get("SELECT id FROM inbound_uploads WHERE id = ?", uploaded.attachment_id)?.id, uploaded.attachment_id);

  const withText = await postJson(api, `/api/v1/conversations/${conversationId}/messages`, { body: "look", attachment_ids: [uploaded.attachment_id] });
  assert.ok(withText.status < 300, `text+attachment status ${withText.status}`);
  const withTextId = (await withText.json()).data.message_id;

  const second = (await (await upload(api, "conversations", conversationId, { name: "two.txt", key: "u2" })).json()).data;
  const fileOnly = await postJson(api, `/api/v1/conversations/${conversationId}/messages`, { body: "", attachment_ids: [second.attachment_id] });
  assert.ok(fileOnly.status < 300, `file-only status ${fileOnly.status}`);
  const fileOnlyId = (await fileOnly.json()).data.message_id;

  const textOnly = await postJson(api, `/api/v1/conversations/${conversationId}/messages`, { body: "plain", attachment_ids: [] });
  assert.ok(textOnly.status < 300);
  const textOnlyId = (await textOnly.json()).data.message_id;

  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", withTextId).body, "look");
  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", fileOnlyId).body, "");
  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", textOnlyId).body, "plain");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?, ?)", withTextId, fileOnlyId, textOnlyId).n, 3);

  const listed = await (await fetch(`${api.baseUrl}/api/v1/conversations/${conversationId}/messages`, { headers: authHeaders })).json();
  const byId = new Map(listed.data.map((message) => [message.id, message]));
  assert.deepEqual(byId.get(withTextId).attachments, [{ id: uploaded.attachment_id, filename: "note.txt", mime: "text/plain", bytes: 5, status: "stored" }]);
  assert.equal(byId.get(textOnlyId).attachments, undefined);
  assert.equal(JSON.stringify(listed).includes("shared_copy_path"), false);
});

test("conversation attachments: neither text nor attachment, or a foreign attachment, is a validation_error", async (t) => {
  const server = await startAdapterServer(t);
  if (!server) return;
  const { api, core } = server;
  const { conversation_id: conversationId } = await core.getActiveConversation();
  const empty = await postJson(api, `/api/v1/conversations/${conversationId}/messages`, { body: "  ", attachment_ids: [] });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, "validation_error");
  const tooMany = await postJson(api, `/api/v1/conversations/${conversationId}/messages`, {
    body: "x",
    attachment_ids: Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`),
  });
  assert.equal(tooMany.status, 400);
});

test("upload errors: oversize Content-Length is 413 with max_bytes, a missing or unsafe filename is 400, executables are quarantined", async (t) => {
  const server = await startAdapterServer(t);
  if (!server) return;
  const { api, core } = server;
  const { conversation_id: conversationId } = await core.getActiveConversation();

  const big = await upload(api, "conversations", conversationId, { key: "big", body: Buffer.alloc(MAX_UPLOAD_BYTES + 1), mime: "application/octet-stream" }).catch((error) => error);
  if (big instanceof Response) {
    assert.equal(big.status, 413);
    const body = await big.json();
    assert.equal(body.error.code, "upload_too_large");
    assert.equal(body.error.details.max_bytes, MAX_UPLOAD_BYTES);
  }

  const missing = await fetch(`${api.baseUrl}/api/v1/conversations/${conversationId}/attachments`, {
    method: "POST",
    headers: { ...authHeaders, "x-request-id": "r", "idempotency-key": "k-missing", "content-type": "text/plain" },
    body: "x",
  });
  assert.equal(missing.status, 400);

  const unsafe = await upload(api, "conversations", conversationId, { name: "a/b.txt", key: "unsafe" });
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).error.code, "validation_error");

  const script = await upload(api, "conversations", conversationId, { name: "run.sh", body: "#!/bin/sh\n", key: "sh", mime: "text/x-shellscript" });
  assert.equal(script.status, 201);
  assert.equal((await script.json()).data.status, "quarantined");
});

test("work attachments: upload and message go through the Work conversation, and getWorkConversation lists attachments", async (t) => {
  const server = await startAdapterServer(t);
  if (!server) return;
  const { api, core, db } = server;
  const workId = await runningWork(core, db);

  const response = await upload(api, "works", workId, { key: "w1" });
  assert.equal(response.status, 201);
  const uploaded = (await response.json()).data;

  const posted = await postJson(api, `/api/v1/works/${workId}/messages`, { body: "", attachment_ids: [uploaded.attachment_id] });
  assert.ok(posted.status < 300, `work file-only status ${posted.status}`);
  const messageId = (await posted.json()).data.message_id;
  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", messageId).body, "");

  const conversation = await (await fetch(`${api.baseUrl}/api/v1/works/${workId}/conversation`, { headers: authHeaders })).json();
  const message = conversation.data.messages.find((item) => item.id === messageId);
  assert.deepEqual(message.attachments.map((item) => item.id), [uploaded.attachment_id]);

  const empty = await postJson(api, `/api/v1/works/${workId}/messages`, { body: "", attachment_ids: [] });
  assert.equal(empty.status, 400);
});

test("a Core without Web attachment support answers 503 dependency_unavailable", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "api-web-attachments-503" }, { prefix: "owl-api-web-attachments-503-" });
  const limited = Object.create(core, { uploadWebAttachment: { value: undefined } });
  const adapter = new ExternalCoreAdapter(limited, db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root }, { token: "owner-token" });
  if (!api) return t.skip("localhost listen is unavailable");
  const response = await upload(api, "conversations", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "dependency_unavailable");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { uploadAttachment } from "../../packages/plugin-sdk/dist/shared/index.js";

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    request: async (path, options) => {
      calls.push({ path, options });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected request to ${path}`);
      return response;
    },
  };
}

test("uploadAttachment registers, PUTs content with a matching sha-256 Digest, and completes the upload in exactly three requests", async () => {
  const bytes = Buffer.from("hello attachment", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const client = fakeClient([
    { upload_id: "UPLOAD1", conversation_id: "CONV1" },
    {},
    { upload_id: "UPLOAD1", status: "stored" },
  ]);

  const result = await uploadAttachment(client, {
    provider: "slack",
    account_id: "ACCT1",
    external_attachment_id: "FILE1",
    conversation_hint: { work_id: null, dm_ref: "C1", thread_ref: null },
    work_id: null,
    file: { name: "report.txt", mime: "text/plain", bytes },
  });

  assert.deepEqual(result, { upload_id: "UPLOAD1", conversation_id: "CONV1", status: "stored" });
  assert.equal(client.calls.length, 3, "register, PUT content, and complete must be exactly one call each");

  const [register, put, complete] = client.calls;
  assert.equal(register.path, "/inbound/uploads");
  assert.equal(register.options.method, "POST");
  assert.equal(register.options.headers["Idempotency-Key"], "slack:upload:ACCT1:FILE1");
  assert.deepEqual(register.options.body, {
    provider: "slack",
    account_id: "ACCT1",
    external_attachment_id: "FILE1",
    filename: "report.txt",
    declared_mime: "text/plain",
    declared_bytes: bytes.byteLength,
    sha256,
    work_id: null,
    conversation_id: null,
    conversation_hint: { work_id: null, dm_ref: "C1", thread_ref: null },
  });

  assert.equal(put.path, "/inbound/uploads/UPLOAD1/content");
  assert.equal(put.options.method, "PUT");
  assert.equal(put.options.body, bytes, "the PUT body must be the raw bytes Buffer, not a re-encoded copy");
  assert.equal(put.options.headers["Content-Type"], "text/plain");
  assert.equal(put.options.headers["Content-Length"], String(bytes.byteLength));
  assert.equal(put.options.headers.Digest, `sha-256=${Buffer.from(sha256, "hex").toString("base64")}`);

  assert.equal(complete.path, "/inbound/uploads/UPLOAD1/complete");
  assert.equal(complete.options.method, "POST");
  assert.equal(complete.options.body.idempotency_key, "slack:upload:ACCT1:FILE1:complete");
  assert.equal(complete.options.body.expected_version, 0);
  assert.deepEqual(complete.options.body.payload, { bytes: bytes.byteLength, sha256, mime: "text/plain" });
  assert.ok(
    typeof complete.options.body.request_id === "string" && complete.options.body.request_id.length > 0,
    "commandEnvelopeFor must generate a request_id",
  );
});

test("uploadAttachment reports a quarantined result without throwing", async () => {
  const bytes = Buffer.from("#!/bin/sh\necho hi\n", "utf8");
  const client = fakeClient([
    { upload_id: "UPLOAD2", conversation_id: "CONV2" },
    {},
    { upload_id: "UPLOAD2", status: "quarantined" },
  ]);

  const result = await uploadAttachment(client, {
    provider: "discord",
    account_id: "ACCT2",
    external_attachment_id: "FILE2",
    conversation_hint: { work_id: null, dm_ref: "C2", thread_ref: "T2" },
    work_id: null,
    file: { name: "malware.sh", mime: "text/x-shellscript", bytes },
  });

  assert.deepEqual(result, { upload_id: "UPLOAD2", conversation_id: "CONV2", status: "quarantined" });
});

test("uploadAttachment's idempotency key is stable for the same (provider, account_id, external_attachment_id), so a retry replays instead of re-registering", async () => {
  const bytes = Buffer.from("retry me", "utf8");
  const request = {
    provider: "slack",
    account_id: "ACCT3",
    external_attachment_id: "FILE3",
    conversation_hint: { work_id: null, dm_ref: "C3", thread_ref: null },
    work_id: null,
    file: { name: "a.txt", mime: "text/plain", bytes },
  };

  const first = fakeClient([
    { upload_id: "UPLOAD3", conversation_id: "CONV3" },
    {},
    { upload_id: "UPLOAD3", status: "stored" },
  ]);
  await uploadAttachment(first, request);

  const second = fakeClient([
    { upload_id: "UPLOAD3", conversation_id: "CONV3" },
    {},
    { upload_id: "UPLOAD3", status: "stored" },
  ]);
  await uploadAttachment(second, request);

  assert.equal(first.calls[0].options.headers["Idempotency-Key"], second.calls[0].options.headers["Idempotency-Key"]);
  assert.equal(first.calls[2].options.body.idempotency_key, second.calls[2].options.body.idempotency_key);
});

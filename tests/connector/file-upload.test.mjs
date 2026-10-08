import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { SlackConnector, downloadFile } from "../../packages/connector-slack/dist/index.js";
import { DiscordConnector, downloadAttachment } from "../../packages/connector-discord/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

// Both connectors handle a file_upload intent by: downloading each file to
// an OS temp dir, hashing it, uploading it through plugin-sdk's
// uploadAttachment (register -> PUT content -> complete), deleting the temp
// file, then sending exactly one /inbound/messages call carrying every
// attachment_id from the batch. These tests mock the platform's file
// download (global fetch) and Core's HTTP endpoints to assert that shape.

/** Directories still left under the OS temp dir matching an "owl-*-upload-*" prefix. */
async function leftoverUploadDirs() {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => /^owl-(slack|discord)-upload-/u.test(name));
}

/** A Core HTTP fake for the inbound-uploads + inbound-messages request sequence. */
function coreRequestFake({ quarantineIds = new Set() } = {}) {
  const calls = [];
  let nextUploadId = 1;
  const request = async (path, options = {}) => {
    // The connector's language() lookup shares this same request() stub;
    // it is not part of the upload sequence under test.
    if (path === "/settings/language") return { language: "ja" };
    calls.push({ path, method: options.method, body: options.body, headers: options.headers });
    if (path === "/inbound/uploads") {
      const uploadId = `UPLOAD${nextUploadId++}`;
      return { upload_id: uploadId, conversation_id: "CONV-UPLOAD" };
    }
    if (/^\/inbound\/uploads\/[^/]+\/content$/u.test(path)) {
      return {};
    }
    const completeMatch = /^\/inbound\/uploads\/([^/]+)\/complete$/u.exec(path);
    if (completeMatch) {
      const uploadId = completeMatch[1];
      return { upload_id: uploadId, status: quarantineIds.has(uploadId) ? "quarantined" : "stored" };
    }
    if (path === "/inbound/messages") {
      return {};
    }
    throw new Error(`Unexpected Core request: ${path}`);
  };
  return { calls, request };
}

function uploadIdsInOrder(calls) {
  return calls.filter((c) => c.path === "/inbound/uploads").map((_, i) => `UPLOAD${i + 1}`);
}

test("Slack file_upload: two files register/PUT/complete in order, one inbound message with both attachment_ids, temp files removed", async () => {
  const before = await leftoverUploadDirs();
  const fileBytes1 = Buffer.from("first file contents", "utf8");
  const fileBytes2 = Buffer.from("#!/bin/sh\necho hi\n", "utf8");
  const responsesByUrl = new Map([
    ["https://files.slack.example/file1.txt", fileBytes1],
    ["https://files.slack.example/file2.sh", fileBytes2],
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const bytes = responsesByUrl.get(String(url));
    if (!bytes) throw new Error(`Unexpected download URL: ${url}`);
    return new Response(bytes, { status: 200 });
  };

  const { calls, request } = coreRequestFake({ quarantineIds: new Set(["UPLOAD2"]) });
  const posts = [];

  try {
    const connector = new SlackConnector({
      botToken: "xoxb-file-upload-test",
      appToken: "xapp-file-upload-test",
      conversationChannelId: "C-FILE-UPLOAD",
      notificationChannelId: "C-FILE-UPLOAD-NOTIFICATIONS",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      accountId: "ACCT-SLACK-UPLOAD",
    });
    connector.web.chat.postMessage = async (message) => { posts.push(message); return { ok: true }; };
    connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
    connector.core.request = request;

    await connector.handleMessage({
      user: "U-FILE-UPLOAD",
      text: "",
      channel: "C-FILE-UPLOAD",
      ts: "1712400000.000100",
      files: [
        { id: "F1", name: "file1.txt", size: fileBytes1.byteLength, mimetype: "text/plain", url_private_download: "https://files.slack.example/file1.txt" },
        { id: "F2", name: "file2.sh", size: fileBytes2.byteLength, mimetype: "text/x-shellscript", url_private_download: "https://files.slack.example/file2.sh" },
      ],
    });

    // register(1) -> content(1) -> complete(1) -> register(2) -> content(2) -> complete(2) -> inbound
    // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
    assert.deepEqual(calls.map((c) => c.path), [
      "/inbound/uploads",
      "/inbound/uploads/UPLOAD1/content",
      "/inbound/uploads/UPLOAD1/complete",
      "/inbound/uploads",
      "/inbound/uploads/UPLOAD2/content",
      "/inbound/uploads/UPLOAD2/complete",
      "/inbound/messages",
    ]);
    assert.equal(uploadIdsInOrder(calls).length, 2);

    const inboundCall = calls.find((c) => c.path === "/inbound/messages");
    assert.equal(inboundCall.method, "POST");
    assert.equal(inboundCall.body.text, "");
    assert.deepEqual(inboundCall.body.attachment_ids, ["UPLOAD1", "UPLOAD2"]);

    assert.equal(posts.length, 2, "one receipt notice per file");
    assert.match(posts[0].text, /file1\.txt/u);
    assert.doesNotMatch(posts[0].text, /実行ファイル/u);
    assert.match(posts[1].text, /file2\.sh/u);
    assert.match(posts[1].text, /実行ファイルのため実行はしません/u, "the quarantined file's notice includes the executable warning");

    const after = await leftoverUploadDirs();
    assert.deepEqual(after, before, "no temp upload directory is left behind");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack file_upload: a download failure rejects, sends no Core request, and leaves no temp directory", async () => {
  const before = await leftoverUploadDirs();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network unreachable"); };

  const { calls, request } = coreRequestFake();
  const posts = [];

  try {
    const connector = new SlackConnector({
      botToken: "xoxb-file-upload-fail-test",
      appToken: "xapp-file-upload-fail-test",
      conversationChannelId: "C-FILE-UPLOAD-FAIL",
      notificationChannelId: "C-FILE-UPLOAD-FAIL-NOTIFICATIONS",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      accountId: "ACCT-SLACK-UPLOAD-FAIL",
    });
    connector.web.chat.postMessage = async (message) => { posts.push(message); return { ok: true }; };
    connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
    connector.core.request = request;

    await assert.rejects(() => connector.handleMessage({
      user: "U-FILE-UPLOAD-FAIL",
      text: "",
      channel: "C-FILE-UPLOAD-FAIL",
      ts: "1712400100.000100",
      files: [
        { id: "F1", name: "file1.txt", size: 10, mimetype: "text/plain", url_private_download: "https://files.slack.example/unreachable.txt" },
      ],
    }));

    assert.equal(calls.length, 0, "no Core request is made when the download itself fails");
    assert.equal(posts.length, 0);

    const after = await leftoverUploadDirs();
    assert.deepEqual(after, before, "no temp upload directory is left behind after a download failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack Socket Mode routes user-authored file_share and thread_broadcast messages but still drops bot and edit events", async () => {
  const fileBytes = Buffer.from("shared file contents", "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(fileBytes, { status: 200 });

  const { calls, request } = coreRequestFake();
  try {
    const connector = new SlackConnector({
      botToken: "xoxb-file-share-test",
      appToken: "xapp-file-share-test",
      conversationChannelId: "C-FILE-SHARE",
      notificationChannelId: "C-FILE-SHARE-NOTIFICATIONS",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      accountId: "ACCT-SLACK-FILE-SHARE",
    });
    const handlers = new Map();
    connector.socket.on = (name, handler) => { handlers.set(name, handler); return connector.socket; };
    connector.socket.start = async () => ({ ok: true });
    connector.socket.disconnect = async () => {};
    connector.core.subscribeEvents = async () => {};
    connector.web.chat.postMessage = async () => ({ ok: true });
    connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
    connector.core.request = request;
    await connector.start();

    const deliver = (event) => handlers.get("message")({ ack: async () => {}, event });
    await deliver({
      subtype: "file_share",
      user: "U-FILE-SHARE",
      text: "",
      channel: "C-FILE-SHARE",
      ts: "1712400200.000100",
      files: [{ id: "F1", name: "shared.txt", size: fileBytes.byteLength, mimetype: "text/plain", url_private_download: "https://files.slack.example/shared.txt" }],
    });
    await deliver({ subtype: "thread_broadcast", user: "U-FILE-SHARE", text: "also in channel", channel: "C-FILE-SHARE", ts: "1712400201.000100", thread_ts: "1712400100.000100" });
    await deliver({ subtype: "bot_message", bot_id: "B1", text: "bot echo", channel: "C-FILE-SHARE", ts: "1712400202.000100" });
    await deliver({ subtype: "file_share", bot_id: "B1", user: "U-BOT", text: "bot file", channel: "C-FILE-SHARE", ts: "1712400203.000100", files: [] });
    await deliver({ subtype: "message_changed", user: "U-FILE-SHARE", text: "edited", channel: "C-FILE-SHARE", ts: "1712400204.000100" });

    const inbound = calls.filter((c) => c.path === "/inbound/messages");
    assert.equal(inbound.length, 2, "only the two user-authored messages reach Core");
    assert.equal(inbound[0].body.attachment_ids.length, 1, "the file_share message carries its uploaded file");
    assert.equal(inbound[1].body.text, "also in channel");
    await connector.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** A fetch whose body sends one chunk and then stalls until the request signal aborts. */
function stalledBodyFetch() {
  return async (_url, init = {}) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      init.signal?.addEventListener("abort", () => controller.error(init.signal.reason ?? new Error("aborted")));
    },
  }), { status: 200 });
}

/** Settle state of a promise after letting real I/O callbacks run, without waiting on mocked timers. */
async function settledState(promise) {
  let state = "pending";
  promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  for (let turn = 0; turn < 500 && state === "pending"; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return state;
}

for (const [platform, download] of [
  ["Slack", (dir) => downloadFile("xoxb-stall-test", { id: "F1", name: "stall.txt", size: 10, mimetype: "text/plain", url_private_download: "https://files.slack.example/stall.txt" }, dir)],
  ["Discord", (dir) => downloadAttachment({ id: "F1", name: "stall.txt", size: 10, contentType: "text/plain", url: "https://cdn.discord.example/stall.txt" }, dir)],
]) {
  test(`${platform} download timeout also aborts a response body that stalls after the headers, leaving no partial file`, async (t) => {
    const dir = await tempDir(t, "owl-download-stall-");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stalledBodyFetch();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = download(dir);
      pending.catch(() => undefined);
      assert.equal(await settledState(pending), "pending", "the body is still streaming before the timeout");
      t.mock.timers.tick(60 * 60 * 1000);
      assert.equal(await settledState(pending), "rejected", "a stalled body must not hang the download forever");
      assert.deepEqual(await readdir(dir), [], "the partial download is removed");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
    }
  });
}

function discordAttachment({ id, name, size, contentType, url }) {
  return { id, name, size, contentType, url };
}

function discordMessage({ id, channelId, attachments, sends }) {
  return {
    id,
    channelId,
    author: { id: "U-DISCORD-UPLOAD", bot: false },
    content: "",
    reference: null,
    channel: {
      isTextBased: () => true,
      send: async (message) => { sends.push(message); return { id: `M-${id}` }; },
    },
    attachments: new Map(attachments.map((a) => [a.id, a])),
  };
}

test("Discord file_upload: two attachments register/PUT/complete in order, one inbound message with both attachment_ids, temp files removed", async () => {
  const before = await leftoverUploadDirs();
  const fileBytes1 = Buffer.from("first attachment contents", "utf8");
  const fileBytes2 = Buffer.from("#!/bin/sh\necho hi\n", "utf8");
  const responsesByUrl = new Map([
    ["https://cdn.discord.example/file1.txt", fileBytes1],
    ["https://cdn.discord.example/file2.sh", fileBytes2],
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const bytes = responsesByUrl.get(String(url));
    if (!bytes) throw new Error(`Unexpected download URL: ${url}`);
    return new Response(bytes, { status: 200 });
  };

  const { calls, request } = coreRequestFake({ quarantineIds: new Set(["UPLOAD2"]) });
  const sends = [];

  try {
    const connector = new DiscordConnector({
      botToken: "discord-file-upload-test",
      conversationChannelId: "D-FILE-UPLOAD",
      notificationChannelId: "D-FILE-UPLOAD-NOTIFICATIONS",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      accountId: "ACCT-DISCORD-UPLOAD",
    });
    connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
    connector.core.request = request;

    const message = discordMessage({
      id: "MSG-UPLOAD-1",
      channelId: "D-FILE-UPLOAD",
      sends,
      attachments: [
        discordAttachment({ id: "F1", name: "file1.txt", size: fileBytes1.byteLength, contentType: "text/plain", url: "https://cdn.discord.example/file1.txt" }),
        discordAttachment({ id: "F2", name: "file2.sh", size: fileBytes2.byteLength, contentType: "text/x-shellscript", url: "https://cdn.discord.example/file2.sh" }),
      ],
    });

    await connector.handleMessage(message);

    // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
    assert.deepEqual(calls.map((c) => c.path), [
      "/inbound/uploads",
      "/inbound/uploads/UPLOAD1/content",
      "/inbound/uploads/UPLOAD1/complete",
      "/inbound/uploads",
      "/inbound/uploads/UPLOAD2/content",
      "/inbound/uploads/UPLOAD2/complete",
      "/inbound/messages",
    ]);

    const inboundCall = calls.find((c) => c.path === "/inbound/messages");
    assert.equal(inboundCall.method, "POST");
    assert.equal(inboundCall.body.text, "");
    assert.deepEqual(inboundCall.body.attachment_ids, ["UPLOAD1", "UPLOAD2"]);

    assert.equal(sends.length, 2, "one receipt notice per attachment");
    assert.match(sends[0].content, /file1\.txt/u);
    assert.doesNotMatch(sends[0].content, /実行ファイル/u);
    assert.match(sends[1].content, /file2\.sh/u);
    assert.match(sends[1].content, /実行ファイルのため実行はしません/u, "the quarantined file's notice includes the executable warning");

    const after = await leftoverUploadDirs();
    assert.deepEqual(after, before, "no temp upload directory is left behind");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord file_upload: a download failure rejects, sends no Core request, and leaves no temp directory", async () => {
  const before = await leftoverUploadDirs();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network unreachable"); };

  const { calls, request } = coreRequestFake();
  const sends = [];

  try {
    const connector = new DiscordConnector({
      botToken: "discord-file-upload-fail-test",
      conversationChannelId: "D-FILE-UPLOAD-FAIL",
      notificationChannelId: "D-FILE-UPLOAD-FAIL-NOTIFICATIONS",
      coreApiBase: "http://127.0.0.1:1/api/v1",
      accountId: "ACCT-DISCORD-UPLOAD-FAIL",
    });
    connector.core.requestPage = async () => ({ data: [], cursor: null, has_more: false });
    connector.core.request = request;

    const message = discordMessage({
      id: "MSG-UPLOAD-FAIL",
      channelId: "D-FILE-UPLOAD-FAIL",
      sends,
      attachments: [
        discordAttachment({ id: "F1", name: "file1.txt", size: 10, contentType: "text/plain", url: "https://cdn.discord.example/unreachable.txt" }),
      ],
    });

    await assert.rejects(() => connector.handleMessage(message));

    assert.equal(calls.length, 0, "no Core request is made when the download itself fails");
    assert.equal(sends.length, 0);

    const after = await leftoverUploadDirs();
    assert.deepEqual(after, before, "no temp upload directory is left behind after a download failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { SlackConnector } from "../../packages/connector-slack/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const NOW = "2030-01-02T03:04:05.000Z";

test("provider pause and resume events reach Slack and the provider pauses API", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  // Registered before the temporary directory so it runs first: the connector stops, then the Core shuts down
  // (which closes the database), and the directory is removed last.
  let connector;
  let apiCore;
  t.after(async () => {
    await connector?.stop();
    await apiCore?.shutdown({ force: true, timeoutMs: 5_000 });
  });
  const root = await tempDir(t, "owl-provider-pause-notify-e2e-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = createTestDatabase(root);
  const { core: durableCore } = await createTestCore(t, {
    db,
    agentRunner: {},
    version: "provider-pause-notify-e2e-test",
    owlRoot: root,
    dataDir,
    now: () => new Date().toISOString(),
  });
  apiCore = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(24).toString("hex");
  const api = await startTestHttpServer(t, { core: apiCore, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) return t.skip("localhost listen is unavailable");

  const posted = [];
  const received = [];
  let subscribedTypes = [];
  let unsubscribe = () => {};
  connector = Object.create(SlackConnector.prototype);
  connector.notificationChannelIds = ["C_PROVIDER_PAUSE_TEST"];
  connector.web = {
    chat: { postMessage: async (message) => { posted.push(message); return { ts: String(posted.length) }; } },
  };
  connector.socket = { on() {}, start: async () => {}, disconnect: async () => {} };
  connector.core = {
    subscribeEvents: async (types, handler) => {
      subscribedTypes = types;
      unsubscribe = durableCore.subscribe(async (event) => {
        if (!types.includes(event.type)) return;
        received.push(event);
        await handler(event);
      });
    },
    language: async () => "ja",
    close: () => unsubscribe(),
  };

  await durableCore.start();
  await connector.start();

  assert.ok(subscribedTypes.includes("provider.paused"));
  assert.ok(subscribedTypes.includes("provider.resumed"));

  const requestPauses = async () => {
    const response = await api.request("GET", "/api/v1/providers/pauses");
    assert.equal(response.status, 200);
    return (await response.json()).data.pauses;
  };

  const pause = await durableCore.providerPauseController.recordRateLimit({
    provider: "anthropic",
    resets_at: "2030-01-02T03:05:05.000Z",
    role: "worker",
  });
  assert.equal(pause.resume_at, "2030-01-02T03:05:35.000Z");

  const listed = await requestPauses();
  assert.equal(listed.length, 1);
  assert.deepEqual(
    { provider: listed[0].provider, state: listed[0].state, resume_at: listed[0].resume_at },
    { provider: "anthropic", state: "paused", resume_at: pause.resume_at },
  );

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /^⏳ 利用上限で停止中: Anthropic/u);
  assert.doesNotMatch(posted[0].text, /<!date\^/u, "the fallback stays plain text");
  const body = posted[0].attachments[0].blocks.find((block) => block.type === "section").text.text;
  const dateToken = body.match(/<!date\^(\d+)\^\{date_short_pretty\} \{time\}\|[^>]+>/u);
  assert.ok(dateToken, "the pause notification includes Slack's resume-time date token");
  assert.equal(Number(dateToken[1]), Date.parse(pause.resume_at) / 1_000);

  const pauseOutbox = db.get(
    `SELECT outbox.provider, outbox.status
       FROM events JOIN outbox_deliveries AS outbox ON outbox.event_id = events.id
      WHERE events.type = 'provider.paused'`,
  );
  assert.deepEqual(pauseOutbox, { provider: "websocket", status: "delivered" });

  t.mock.timers.tick(90_000);
  for (let i = 0; i < 10; i += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.deepEqual(received.map((event) => event.type), ["provider.paused", "provider.resumed"]);
  assert.ok(received.every((event) => event.event_id && event.sequence > 0));
  assert.equal(posted.length, 2);
  assert.equal(posted[1].text, "▶️ 処理を再開しました: Anthropic");

  const resumeOutbox = db.get(
    `SELECT outbox.provider, outbox.status
       FROM events JOIN outbox_deliveries AS outbox ON outbox.event_id = events.id
      WHERE events.type = 'provider.resumed'`,
  );
  assert.deepEqual(resumeOutbox, { provider: "websocket", status: "delivered" });

  await durableCore.providerPauseController.noteProviderSucceeded("anthropic", new Date().toISOString());
  assert.deepEqual(await requestPauses(), []);
});

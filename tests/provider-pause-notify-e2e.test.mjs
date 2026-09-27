import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { SlackConnector } from "../packages/connector-slack/dist/index.js";
import { Core } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const NOW = "2030-01-02T03:04:05.000Z";
const repoRoot = resolve(process.cwd());

test("provider pause and resume events reach Slack and the provider pauses API", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const root = await mkdtemp(join(tmpdir(), "owl-provider-pause-notify-e2e-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const durableCore = new Core({
    db,
    agentRunner: {},
    version: "provider-pause-notify-e2e-test",
    owlRoot: root,
    dataDir,
    now: () => new Date().toISOString(),
  });
  const apiCore = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(24).toString("hex");
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core: apiCore,
    db,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    dataDir,
  });

  const posted = [];
  const received = [];
  let subscribedTypes = [];
  let unsubscribe = () => {};
  const connector = Object.create(SlackConnector.prototype);
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

  t.after(async () => {
    await connector.stop();
    if (http.server.listening) await http.close();
    await apiCore.shutdown({ force: true, timeoutMs: 5_000 });
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });

  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return;
    }
    throw error;
  }
  await durableCore.start();
  await connector.start();

  assert.ok(subscribedTypes.includes("provider.paused"));
  assert.ok(subscribedTypes.includes("provider.resumed"));

  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const requestPauses = async () => {
    const response = await fetch(`${base}/providers/pauses`, {
      headers: { authorization: `Bearer ${token}` },
    });
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
  assert.match(posted[0].text, /^⏸ Anthropicが利用上限に達したため/u);
  const dateToken = posted[0].text.match(/<!date\^(\d+)\^\{date_short_pretty\} \{time\}\|[^>]+>/u);
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
  assert.equal(posted[1].text, "▶ Anthropicの利用上限が解除されたため、処理を再開しました。");

  const resumeOutbox = db.get(
    `SELECT outbox.provider, outbox.status
       FROM events JOIN outbox_deliveries AS outbox ON outbox.event_id = events.id
      WHERE events.type = 'provider.resumed'`,
  );
  assert.deepEqual(resumeOutbox, { provider: "websocket", status: "delivered" });

  await durableCore.providerPauseController.noteProviderSucceeded("anthropic", new Date().toISOString());
  assert.deepEqual(await requestPauses(), []);
});

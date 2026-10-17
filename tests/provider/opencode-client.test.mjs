// opencode serve client: startup, auth, SSE and shutdown, exercised against the fake opencode.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { OpencodeHttpError, OpencodeStartError, createOpencodeClient, startOpencodeServer } from "../../packages/agent-runtime/dist/index.js";
import { writeFakeOpencode } from "../helpers/fake-opencode.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function start(t, extraEnv = {}, input = {}) {
  const root = await tempDir(t, "owl-opencode-client-");
  const executable = await writeFakeOpencode(root);
  const password = randomBytes(12).toString("hex");
  const server = await startOpencodeServer({
    executable,
    cwd: root,
    env: { PATH: process.env.PATH ?? "", OPENCODE_PASSWORD: password, FAKE_OPENCODE_HEARTBEAT_MS: "20", ...extraEnv },
    ...input,
  });
  t.after(() => server.stop(1000));
  return { server, password };
}

const alive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

test("startOpencodeServer reads the URL from stdout and the version from /api/info", async (t) => {
  const { server } = await start(t, { FAKE_OPENCODE_VERSION: "2.3.4" });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(server.version, "2.3.4");
  assert.equal(typeof server.pid, "number");
});

test("a version below the minimum fails startup and leaves no process", async (t) => {
  const root = await tempDir(t, "owl-opencode-old-");
  const executable = await writeFakeOpencode(root);
  await assert.rejects(
    startOpencodeServer({ executable, cwd: root, env: { PATH: process.env.PATH ?? "", OPENCODE_PASSWORD: "p", FAKE_OPENCODE_VERSION: "1.18.23" } }),
    (error) => error instanceof OpencodeStartError && error.code === "opencode_version_unsupported",
  );
});

test("an external plugin fails startup", async (t) => {
  const root = await tempDir(t, "owl-opencode-plugin-");
  const executable = await writeFakeOpencode(root);
  await assert.rejects(
    startOpencodeServer({ executable, cwd: root, env: { PATH: process.env.PATH ?? "", OPENCODE_PASSWORD: "p", FAKE_OPENCODE_PLUGINS: JSON.stringify([{ id: "x", source: { type: "npm" } }]) } }),
    (error) => error.code === "opencode_external_plugin",
  );
});

test("the client authenticates with Basic opencode:<password>; a different password gets 401 as OpencodeHttpError", async (t) => {
  const { server, password } = await start(t);
  const info = await server.client.request("GET", "/api/info");
  assert.equal(info.version, server.version);
  const wrong = createOpencodeClient(server.url, `${password}-wrong`);
  await assert.rejects(wrong.request("GET", "/api/info"), (error) => error instanceof OpencodeHttpError && error.status === 401 && typeof error.body === "string");
});

test("a non-2xx answer carries status and body", async (t) => {
  const { server } = await start(t);
  await assert.rejects(server.client.request("GET", "/api/session/missing"), (error) => error instanceof OpencodeHttpError && error.status === 404 && error.body.length > 0);
});

test("events yields {id, type, data} and counts heartbeats", async (t) => {
  const { server } = await start(t);
  const controller = new AbortController();
  const seen = [];
  setTimeout(() => controller.abort(), 200);
  for await (const event of server.client.events(controller.signal)) seen.push(event);
  assert.equal(seen[0].type, "server.connected");
  assert.equal(typeof seen[0].id, "string");
  assert.deepEqual(seen[0].data, {});
  assert.ok(server.client.heartbeats >= 1);
});

test("the stream ends as a disconnect when nothing at all arrives for the stall time", async (t) => {
  const { server } = await start(t, { FAKE_OPENCODE_HEARTBEAT_MS: "0" }, { eventStallMs: 150 });
  const controller = new AbortController();
  const types = [];
  const started = Date.now();
  for await (const event of server.client.events(controller.signal)) types.push(event.type);
  assert.deepEqual(types, ["server.connected"]);
  assert.ok(Date.now() - started >= 100);
  assert.equal(server.client.heartbeats, 0);
});

test("heartbeats keep the stream open past the stall time", async (t) => {
  const { server } = await start(t, { FAKE_OPENCODE_HEARTBEAT_MS: "40" }, { eventStallMs: 150 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const started = Date.now();
  for await (const _ of server.client.events(controller.signal));
  assert.ok(Date.now() - started >= 450);
  assert.ok(server.client.heartbeats >= 5);
});

test("stop closes stdin and the whole process group is gone afterwards", async (t) => {
  const { server } = await start(t);
  assert.equal(alive(server.pid), true);
  await server.stop(1000);
  const exit = await server.exited;
  assert.equal(exit.exit_code, 0);
  assert.throws(() => process.kill(-server.pid, 0), (error) => error.code === "ESRCH");
});

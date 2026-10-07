import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

// The WebSocket resume/subscribe handshake: a client reconnecting with a
// cursor > 0 may send `resume` before `subscribe`, so the server must accept
// either order, report the current cursor and the oldest retained sequence
// without scanning the whole event log when the Core exposes fast-path
// methods for that, and page a large backlog instead of sending it as one
// unbounded burst.

function frame(sequence, type = "work.updated") {
  return {
    kind: "event",
    event_id: `01J${String(sequence).padStart(23, "0")}`,
    sequence,
    cursor: String(sequence),
    type,
    schema_version: "1.0.0",
    work_id: null,
    task_id: null,
    agent_run_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence % 60)).toISOString(),
    payload: { n: sequence },
  };
}

/** A minimal CorePort double for the WebSocket route: subscribe + eventsAfter, plus the two optional fast-path methods when `fastPaths` is true. */
function fakeCore(history, { fastPaths = false } = {}) {
  const core = {
    ready: true,
    status: () => ({ services: [], mvp_scope: "test", version: "1.0.0" }),
    subscribe: () => () => {},
    eventsAfter: (cursor, limit) => {
      const after = history.filter((event) => event.sequence > cursor);
      return limit === undefined ? after : after.slice(0, limit);
    },
  };
  if (fastPaths) {
    core.oldestEventSequence = () => history[0]?.sequence ?? null;
    core.latestEventCursor = () => history.at(-1)?.cursor ?? "0";
  }
  return core;
}

async function startServer(t, core) {
  const root = await tempDir(t, "owl-ws-order-");
  const server = await startTestHttpServer(t, { core, webOut: root, owlRoot: root });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return server.http.server.address().port;
}

/** Raw masked client WebSocket text frame (server frames must be masked; owl's server rejects unmasked ones). */
function encodeClientFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Decodes one unmasked server text frame from the front of `buffer`, or null if incomplete. */
function decodeOneServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  if (buffer.length < offset + length) return null;
  const payload = buffer.subarray(offset, offset + length);
  return { payload, rest: buffer.subarray(offset + length) };
}

/** Buffers incoming WebSocket frames off `socket` and hands out parsed JSON messages one at a time. */
class FrameReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = decodeOneServerFrame(this.buffer);
        if (!parsed) return;
        this.buffer = parsed.rest;
        const message = JSON.parse(parsed.payload.toString("utf8"));
        if (this.waiters.length > 0) this.waiters.shift()(message);
        else this.queue.push(message);
      }
    });
  }

  next(timeoutMs = 2_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a WebSocket frame")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

async function openWs(port) {
  const socket = await new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/v1/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (_response, upgradedSocket) => resolve(upgradedSocket));
    req.on("response", (response) => reject(new Error(`upgrade rejected: ${response.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
  const reader = new FrameReader(socket);
  const send = (value) => socket.write(encodeClientFrame(value));
  return { socket, reader, send };
}

test("resume arriving before subscribe still replays the full history, and the later subscribe only narrows the live filter", async (t) => {
  const history = [frame(1, "work.updated"), frame(2, "decision.opened"), frame(3, "work.updated")];
  const port = await startServer(t, fakeCore(history));
  if (!port) return;
  const { socket, reader, send } = await openWs(port);
  t.after(() => socket.destroy());

  send({ kind: "resume", request_id: "r1", cursor: "0" });
  const ready = await reader.next();
  assert.equal(ready.kind, "ready");

  const replayed = [await reader.next(), await reader.next(), await reader.next()];
  assert.deepEqual(replayed.map((event) => event.sequence), [1, 2, 3], "replay before any subscribe is unfiltered");

  send({ kind: "subscribe", request_id: "s1", work_ids: [], event_types: ["work.updated"] });
  const secondReady = await reader.next();
  assert.equal(secondReady.kind, "ready", "subscribe after an already-subscribed resume only re-sends ready");
  // No further frame should follow (no re-replay); confirm the connection is quiet.
  await assert.rejects(() => reader.next(200));
});

test("a resume cursor older than the oldest retained sequence gets a replay_gap error, whether or not the Core exposes the fast-path check", async (t) => {
  for (const fastPaths of [true, false]) {
    const history = [frame(50), frame(51), frame(52)];
    const port = await startServer(t, fakeCore(history, { fastPaths }));
    if (!port) return;
    const { socket, reader, send } = await openWs(port);
    t.after(() => socket.destroy());

    send({ kind: "resume", request_id: "r1", cursor: "0" });
    const ready = await reader.next();
    assert.equal(ready.kind, "ready");
    const error = await reader.next();
    assert.equal(error.kind, "error");
    assert.equal(error.error.code, "replay_gap", `fastPaths=${fastPaths}`);
  }
});

test("the ready cursor and the replay-gap check use the Core's own fast-path methods instead of scanning eventsAfter(0)", async (t) => {
  const history = [frame(1), frame(2)];
  const core = fakeCore(history, { fastPaths: true });
  // Deliberately diverge from what a full eventsAfter(0) scan would report,
  // so a passing assertion below can only be explained by http.ts calling
  // these methods rather than falling back to a scan.
  core.latestEventCursor = () => "999";
  core.oldestEventSequence = () => 500;
  const port = await startServer(t, core);
  if (!port) return;
  const { socket, reader, send } = await openWs(port);
  t.after(() => socket.destroy());

  send({ kind: "subscribe", request_id: "s1", work_ids: [], event_types: [] });
  const ready = await reader.next();
  assert.equal(ready.cursor, "999");

  send({ kind: "resume", request_id: "r1", cursor: "0" });
  const error = await reader.next();
  assert.equal(error.kind, "error");
  assert.equal(error.error.code, "replay_gap", "oldestEventSequence()=500 makes cursor 0 look like a gap");
});

test("a replay larger than one page delivers every event exactly once, in order", async (t) => {
  const total = 1_200; // several times the server's internal replay page size
  const history = Array.from({ length: total }, (_, index) => frame(index + 1));
  const port = await startServer(t, fakeCore(history, { fastPaths: true }));
  if (!port) return;
  const { socket, reader, send } = await openWs(port);
  t.after(() => socket.destroy());

  send({ kind: "resume", request_id: "r1", cursor: "0" });
  await reader.next(); // ready

  const sequences = [];
  for (let i = 0; i < total; i += 1) sequences.push((await reader.next(5_000)).sequence);
  assert.deepEqual(sequences, history.map((event) => event.sequence));
  await assert.rejects(() => reader.next(200), "no extra or duplicated frame follows the full replay");
});

test("ExternalCoreAdapter answers oldestEventSequence/latestEventCursor from MIN/MAX(sequence) when a direct db is available, and falls back to listEventsAfter otherwise", async (t) => {
  const root = await tempDir(t, "owl-ws-order-adapter-");
  const history = [frame(10), frame(11), frame(12)];
  const externalCore = {
    subscribe: () => () => {},
    status: () => ({ services: [], mvp_scope: "test", version: "1.0.0" }),
    listEventsAfter(cursor = 0, limit) {
      const after = history.filter((event) => event.sequence > Number(cursor));
      return limit === undefined ? after : after.slice(0, limit);
    },
  };
  const db = {
    get(sql) {
      if (/MAX\(sequence\)/u.test(sql)) return { max_sequence: 12 };
      if (/MIN\(sequence\)/u.test(sql)) return { min_sequence: 10 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const withDb = new ExternalCoreAdapter(externalCore, db, root, join(root, "data"));
  t.after(() => withDb.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  assert.equal(withDb.oldestEventSequence(), 10);
  assert.equal(withDb.latestEventCursor(), "12");

  const withoutDb = new ExternalCoreAdapter(externalCore, null, root, join(root, "data"));
  t.after(() => withoutDb.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  assert.equal(withoutDb.oldestEventSequence(), 10, "falls back to the first event listEventsAfter(0, 1) returns");
  assert.equal(withoutDb.latestEventCursor(), "12", "falls back to the last event a full eventsAfter(0) scan returns");
});

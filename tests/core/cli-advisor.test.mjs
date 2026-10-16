import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { repoRoot } from "../helpers/paths.mjs";
import { createConfiguredCore } from "../../apps/server/dist/core.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const CONVERSATION = "conv-1";

function responded(sequence, origin, extra = {}) {
  return {
    sequence,
    type: "advisor.responded",
    payload: { conversation_id: CONVERSATION, origin, ...extra },
  };
}

/** Runs `owl advisor` against baseUrl's port, feeding stdinText, and resolves with the exit status and output. */
async function runAdvisor(t, port, stdinText, args = []) {
  const dataDir = await tempDir(t, "owl-cli-advisor-");
  writeFileSync(join(dataDir, "owl-server.json"), JSON.stringify({ pid: process.pid, bind: "127.0.0.1", port }));
  const child = spawn(process.execPath, ["apps/server/dist/cli.js", "advisor", ...args], {
    cwd: repoRoot,
    env: { ...process.env, OWL_DATA_DIR: dataDir, OWL_LANG: "en", OWL_API_TOKEN: "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(stdinText);
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, stdout, stderr };
}

/**
 * Stub Owl API. `history` is the existing event log; onMessage(ref, push) runs when a message is posted and
 * may push new events (sequence numbers continue after the history).
 */
async function startStub(t, history, onMessage = () => {}) {
  const events = [...history];
  const requests = [];
  const posted = [];
  const push = (event) => events.push({ ...event, sequence: events.length ? events[events.length - 1].sequence + 1 : 1 });
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://stub");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      let data;
      if (url.pathname === "/api/v1/advisor/conversation/active") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ conversation_id: CONVERSATION }));
        return;
      } else if (url.pathname === "/api/v1/events") {
        const limit = Number(url.searchParams.get("limit"));
        if (url.searchParams.get("order") === "desc") data = { events: events.slice(-limit).reverse() };
        else {
          const after = Number(url.searchParams.get("after"));
          data = { events: events.filter((event) => event.sequence > after).slice(0, limit) };
        }
        // The real API returns the oldest page for after=0; a cursor taken from it would be stale.
      } else if (url.pathname === "/api/v1/messages") {
        posted.push(JSON.parse(body).text);
        onMessage(JSON.parse(body).origin, push);
        data = { message_id: "m1" };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data ? { data } : { error: "not found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { port: server.address().port, requests, posted };
}

test("owl advisor ignores older replies of the same conversation and prints only the reply to its own message", async (t) => {
  // Old events fill the first page; the cursor must come from the newest event instead.
  const history = Array.from({ length: 5 }, (_, index) => responded(index + 1, { channel: "terminal", ref: "terminal:old" }, { reply: "OLD REPLY" }));
  const stub = await startStub(t, history, (origin, push) => {
    assert.equal(origin.channel, "terminal");
    assert.match(origin.ref, /^terminal:.+/u);
    push(responded(0, { channel: "slack", ref: origin.ref }, { reply: "SLACK REPLY" }));
    push(responded(0, { channel: "web" }, { reply: "WEB REPLY" }));
    push(responded(0, { channel: "terminal", ref: "terminal:other" }, { reply: "OTHER TERMINAL REPLY" }));
    push(responded(0, origin, { reply: "MY REPLY", provider: "claude", model: "claude-sonnet" }));
  });
  const result = await runAdvisor(t, stub.port, "hello\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Thinking\.\.\./u);
  assert.match(result.stdout, /MY REPLY/u);
  assert.doesNotMatch(result.stdout, /OLD REPLY|SLACK REPLY|WEB REPLY|OTHER TERMINAL REPLY/u);
  assert.ok(stub.requests.some((line) => line.includes("/events?order=desc&limit=1")), stub.requests.join("\n"));
});

test("owl advisor identifies the reply the same way for a codex-style provider", async (t) => {
  const stub = await startStub(t, [], (origin, push) => {
    push(responded(0, origin, { reply: "MY REPLY", provider: "codex", model: "gpt-5" }));
  });
  const result = await runAdvisor(t, stub.port, "hello\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MY REPLY/u);
});

test("owl advisor prints action_results with the reply, and only the reply without them", async (t) => {
  const stub = await startStub(t, [], (origin, push) => {
    push(responded(0, origin, { reply: "WITH ACTIONS", action_results: "Created Work W1" }));
    push(responded(0, origin, { reply: "PLAIN", action_results: "" }));
  });
  const withActions = await runAdvisor(t, stub.port, "hello\n");
  assert.match(withActions.stdout, /WITH ACTIONS\n\nCreated Work W1\n/u);

  const plainStub = await startStub(t, [], (origin, push) => {
    push(responded(0, origin, { reply: "PLAIN", action_results: "" }));
  });
  const plain = await runAdvisor(t, plainStub.port, "hello\n");
  assert.match(plain.stdout, /Thinking\.\.\.\nPLAIN\nAdvisor session ended\./u);
});

test("owl advisor times out after --timeout seconds and rejects invalid values", async (t) => {
  const stub = await startStub(t, []);
  const timedOut = await runAdvisor(t, stub.port, "hello\n", ["--timeout", "1"]);
  assert.equal(timedOut.status, 5);
  assert.match(timedOut.stderr, /did not respond in time/u);

  for (const value of ["0", "-3", "abc"]) {
    const result = await runAdvisor(t, stub.port, "", ["--timeout", value]);
    assert.equal(result.status, 2, `--timeout ${value}`);
  }
});

test("owl advisor's message origin is accepted by the real HTTP server and comes back in advisor.responded", async (t) => {
  const root = await tempDir(t, "owl-cli-advisor-real-");
  let currentTurn;
  let readySent = false;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "cli-advisor-session",
      pid: process.pid,
      send: async (turn) => { currentTurn = turn; },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield { type: "session.ready", provider_session_id: "cli-advisor-session", pid: process.pid };
          }
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: `Acknowledged: ${currentTurn.text}`, usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("unused"); },
    runWorker: async () => { throw new Error("unused"); },
    runReviewer: async () => { throw new Error("unused"); },
    runAdvisor: async () => { throw new Error("unused"); },
  };
  const db = createTestDatabase(root);
  const core = await createConfiguredCore({
    db,
    agentRunner,
    providerClient,
    version: "cli-advisor-test",
    owlRoot: root,
    dataDir: root,
    dispatcher: { tick_interval_ms: 25 },
  });
  t.after(async () => { try { await core.core.stop({ force: true }); } finally { db.close(); } });
  core.core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root });
  if (!api) return t.skip("localhost listen is unavailable");

  const result = await runAdvisor(t, Number(new URL(api.baseUrl).port), "ping from terminal\n", ["--timeout", "30"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Acknowledged: ping from terminal/u);
});

/** Runs the advisor REPL in-process on a PassThrough input that readline treats as a terminal. */
async function startTerminalAdvisor(t, port, timeoutSeconds = 5) {
  const { runAdvisor: run } = await import("../../apps/server/dist/cli.js");
  const dataDir = await tempDir(t, "owl-cli-advisor-tty-");
  writeFileSync(join(dataDir, "owl-server.json"), JSON.stringify({ pid: process.pid, bind: "127.0.0.1", port }));
  const saved = { OWL_DATA_DIR: process.env.OWL_DATA_DIR, OWL_LANG: process.env.OWL_LANG, OWL_API_TOKEN: process.env.OWL_API_TOKEN };
  Object.assign(process.env, { OWL_DATA_DIR: dataDir, OWL_LANG: "en", OWL_API_TOKEN: "" });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = "";
  output.on("data", (chunk) => { stdout += chunk; });
  const done = run({ conversationId: null, timeoutSeconds }, { input, output, terminal: true });
  return { input, done, stdout: () => stdout };
}

const until = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 50)); };
const replies = (cli) => (cli.stdout().match(/ok\n/gu) ?? []).length;

test("owl advisor in terminal mode recalls earlier input with the up and down arrow keys", async (t) => {
  const stub = await startStub(t, [], (origin, push) => { push(responded(0, origin, { reply: "ok" })); });
  const cli = await startTerminalAdvisor(t, stub.port);
  cli.input.write("first\r");
  await until(() => replies(cli) === 1);
  cli.input.write("second\r");
  await until(() => replies(cli) === 2);
  cli.input.write("\x1b[A\x1b[A\x1b[B\r"); // up, up, down -> "second"
  await until(() => replies(cli) === 3);
  cli.input.write("\x1b[A\x1b[A\r"); // up, up -> "first"
  await until(() => replies(cli) === 4);
  cli.input.end();
  await cli.done;
  assert.deepEqual(stub.posted, ["first", "second", "second", "first"]);
});

test("owl advisor joins lines ending in a backslash into one multi-line message", async (t) => {
  const stub = await startStub(t, [], (origin, push) => { push(responded(0, origin, { reply: "ok" })); });
  const result = await runAdvisor(t, stub.port, "line one\\\nline two\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stub.posted, ["line one\nline two"]);
});

test("owl advisor Ctrl+C stops waiting without exiting, and only the next message's reply is shown", async (t) => {
  let abandoned;
  const stub = await startStub(t, [], (origin, push) => {
    if (!abandoned) abandoned = { origin, push };
    else push(responded(0, origin, { reply: "SECOND REPLY" }));
  });
  const cli = await startTerminalAdvisor(t, stub.port);
  cli.input.write("first\r");
  await until(() => abandoned);
  cli.input.write("\x03");
  await until(() => /Stopped waiting/u.test(cli.stdout()));
  assert.match(cli.stdout(), /Stopped waiting/u);
  abandoned.push(responded(0, abandoned.origin, { reply: "FIRST REPLY" })); // arrives late
  cli.input.write("typing\x03"); // Ctrl+C while typing does not exit either
  cli.input.write("second\r");
  await until(() => /SECOND REPLY/u.test(cli.stdout()));
  cli.input.end();
  const result = await cli.done;
  assert.equal(result.status, "ok");
  assert.match(cli.stdout(), /SECOND REPLY/u);
  assert.doesNotMatch(cli.stdout(), /FIRST REPLY/u);
  assert.deepEqual(stub.posted, ["first", "second"]);
});

test("owl advisor exits with status 0 when input ends (Ctrl+D)", async (t) => {
  const stub = await startStub(t, []);
  const result = await runAdvisor(t, stub.port, "");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Advisor session ended\./u);
});

test("owl advisor in terminal mode exits with status ok when Ctrl+D is pressed while waiting for a reply", async (t) => {
  let posted = false;
  const stub = await startStub(t, [], () => { posted = true; }); // never replies
  const cli = await startTerminalAdvisor(t, stub.port, 30);
  cli.input.write("first\r");
  await until(() => posted);
  cli.input.write("\x04");
  const result = await Promise.race([
    cli.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("advisor kept waiting after Ctrl+D")), 3000)),
  ]);
  assert.equal(result.status, "ok");
});

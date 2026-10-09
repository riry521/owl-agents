import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createOwnApiCaller } from "../../apps/server/dist/own-api-caller.js";
import { createCore as createMemoryCore, ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

function envelope(payload, key = "k") {
  return { request_id: `req-${key}`, idempotency_key: `idem-${key}`, expected_version: 0, payload };
}

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function startServer(t, core) {
  const root = await tempDir(t, "owl-api-advisor-actions-");
  const api = await startTestHttpServer(t, { core, webOut: root, owlRoot: root });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return { base: api.baseUrl };
}

async function startAdapterServer(t) {
  const { root, db, core } = await createTestCore(t, { version: "api-advisor-actions-test", dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-api-advisor-actions-adapter-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root, dataDir });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return { base: api.baseUrl, core, db };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function action(overrides) {
  return { action_id: createUlid(), sequence: 1, type: "start_work", payload: {}, expected_version: 0, ...overrides };
}

test("/advisor/actions honors each action's own expected_version instead of a batch-wide one", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const core = createMemoryCore({ version: "1.0.0", agentRunner: { start: async () => {} } });
    const server = await startServer(t, core);
    if (!server) return;

    const created = await post(server.base, "/api/v1/works", envelope({ title: "Batch actions", summary: "", size: "normal", project_id: null }, "create"));
    assert.equal(created.response.status, 201);
    const workId = created.body.data.work_id;
    assert.equal(created.body.data.state_version, 0);

    // start_work needs expected_version 0 (the Work's current version); the
    // pause_work that follows in the same batch needs expected_version 1,
    // the version start_work leaves behind. A batch-wide expected_version
    // could satisfy at most one of these.
    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "start_work", payload: { work_id: workId }, expected_version: 0 }),
        action({ sequence: 2, type: "pause_work", payload: { work_id: workId }, expected_version: 1 }),
      ],
    }, "batch"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => result.status), ["executed", "executed"], JSON.stringify(body.data.results));
    assert.equal(body.data.results[0].error_code, null);
    assert.equal(body.data.results[1].error_code, null);

    const detail = await fetch(`${server.base}/api/v1/works/${workId}`);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.state, "paused");
    assert.equal(detailBody.data.state_version, 2);
  });
});

test("/advisor/actions rejects the whole batch when an action omits expected_version", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const core = createMemoryCore({ version: "1.0.0", agentRunner: { start: async () => {} } });
    const server = await startServer(t, core);
    if (!server) return;

    const raw = { action_id: createUlid(), sequence: 1, type: "start_work", payload: {} };
    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [raw],
    }, "missing-version"));

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "validation_error");
  });
});

test("/advisor/actions executes Work operations through ExternalCoreAdapter and applies their effects", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const server = await startAdapterServer(t);
    if (!server) return;

    const runningWorkId = (await server.core.createWork(command({ title: "Instruction target", summary: "", size: "small", project_id: null }, "create-running"))).data.work_id;
    await server.core.startWork(runningWorkId, command({ mode: "normal" }, "start-running"));
    const pausedWorkId = (await server.core.createWork(command({ title: "Resume target", summary: "", size: "small", project_id: null }, "create-paused"))).data.work_id;
    await server.db.createWriteLane().transact((transaction) => {
      transaction.run("UPDATE works SET state = 'paused', state_version = 2 WHERE id = ?", pausedWorkId);
    });

    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "send_work_instruction", payload: { work_id: runningWorkId, body: "Add a regression test." }, expected_version: 1 }),
        action({ sequence: 2, type: "update_work", payload: { work_id: runningWorkId, title: "Advisor updated title" }, expected_version: 1 }),
        action({ sequence: 3, type: "resume_work", payload: { work_id: pausedWorkId }, expected_version: 2 }),
      ],
    }, "adapter-work-operations"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => result.status), ["executed", "executed", "executed"], JSON.stringify(body.data.results));
    assert.ok(body.data.results.every((result) => result.error_code === null));
    assert.equal(server.db.get("SELECT body FROM messages WHERE conversation_id = (SELECT conversation_id FROM works WHERE id = ?)", runningWorkId).body, "Add a regression test.");
    assert.equal(server.core.getWork(runningWorkId).data.title, "Advisor updated title");
    assert.equal(server.core.getWork(pausedWorkId).data.state, "running");
  });
});

test("/advisor/actions rejects missing Works with work_not_found through ExternalCoreAdapter", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const server = await startAdapterServer(t);
    if (!server) return;
    const missingWorkId = createUlid();

    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "send_work_instruction", payload: { work_id: missingWorkId, body: "Do this." } }),
        action({ sequence: 2, type: "update_work", payload: { work_id: missingWorkId, title: "Missing" } }),
        action({ sequence: 3, type: "resume_work", payload: { work_id: missingWorkId } }),
      ],
    }, "missing-work-operations"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => [result.status, result.error_code]), [
      ["rejected", "work_not_found"],
      ["rejected", "work_not_found"],
      ["rejected", "work_not_found"],
    ]);
  });
});

test("/advisor/actions rejects invalid payloads and state violations without changing the Work", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const server = await startAdapterServer(t);
    if (!server) return;
    const runningWorkId = (await server.core.createWork(command({ title: "Running work", summary: "", size: "small", project_id: null }, "invalid-running"))).data.work_id;
    await server.core.startWork(runningWorkId, command({ mode: "normal" }, "invalid-start"));
    const completedWorkId = (await server.core.createWork(command({ title: "Completed work", summary: "", size: "small", project_id: null }, "invalid-completed"))).data.work_id;
    await server.db.createWriteLane().transact((transaction) => {
      transaction.run("UPDATE works SET state = 'completed', state_version = 1 WHERE id = ?", completedWorkId);
    });

    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "send_work_instruction", payload: { work_id: runningWorkId, body: "Do this", attachment_ids: [] }, expected_version: 1 }),
        action({ sequence: 2, type: "update_work", payload: { work_id: runningWorkId }, expected_version: 1 }),
        action({ sequence: 3, type: "update_work", payload: { work_id: completedWorkId, title: "Changed" }, expected_version: 1 }),
        action({ sequence: 4, type: "send_work_instruction", payload: { work_id: completedWorkId, body: "Do this" }, expected_version: 1 }),
        action({ sequence: 5, type: "resume_work", payload: { work_id: completedWorkId }, expected_version: 1 }),
      ],
    }, "invalid-work-operations"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => [result.status, result.error_code]), [
      ["rejected", "validation_error"],
      ["rejected", "validation_error"],
      ["rejected", "invalid_state_transition"],
      ["rejected", "work_reopen_required"],
      ["rejected", "invalid_state_transition"],
    ]);
    assert.equal(server.db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id IN (?, ?))", runningWorkId, completedWorkId).count, 0);
    assert.equal(server.core.getWork(runningWorkId).data.title, "Running work");
    assert.equal(server.core.getWork(completedWorkId).data.title, "Completed work");
    assert.equal(server.core.getWork(completedWorkId).data.state, "completed");
  });
});

test("ふさぐ API の一覧: 31 行を照合し、Project 登録・start・GET は通す", async () => {
  const policy = await import("../../packages/shared/dist/advisor-api-policy.js");
  assert.equal(policy.ADVISOR_BLOCKED_APIS.length, 31);
  for (const row of policy.ADVISOR_BLOCKED_APIS) {
    const pathname = `/api/v1${row.path.replace(/\{[a-z_]+\*\}/, "a/b").replace(/\{[a-z_]+\}/g, "x1")}`;
    assert.equal(policy.matchAdvisorBlockedApi(row.method, pathname), row, `${row.method} ${row.path}`);
    const actions = policy.advisorAlternativeActions(row);
    if (row.kind === "dedicated") {
      assert.ok(actions.length >= 1 && !actions.includes("call_api"));
    } else {
      assert.deepEqual(actions, ["call_api"]);
    }
  }
  for (const [method, path] of [
    ["POST", "/api/v1/projects"], ["POST", "/api/v1/projects/inspect"], ["POST", "/api/v1/projects/setup"],
    ["POST", "/api/v1/works/w1/backlog/link"], ["POST", "/api/v1/works/w1/start"],
    ["GET", "/api/v1/works/w1"], ["GET", "/api/v1/backlog/x1"], ["POST", "/api/v1/works/w1/cancel/x"],
    ["POST", "/api/v1/toString"], ["DELETE", "/api/v1/__proto__"],
  ]) {
    assert.equal(policy.matchAdvisorBlockedApi(method, path), null, `${method} ${path}`);
  }
});

test("validateOwnApiPath は外部 URL・正規化で変わるパス・クエリ（allowQuery=false）を拒む", async () => {
  const { validateOwnApiPath } = await import("../../packages/shared/dist/advisor-api-policy.js");
  assert.deepEqual(validateOwnApiPath("/api/v1/works?limit=1", { allowQuery: true }), { ok: true, pathname: "/api/v1/works", search: "?limit=1" });
  assert.equal(validateOwnApiPath("/api/v1/works").ok, true);
  for (const bad of [
    "http://evil.example/api/v1/x", "//evil.example/api/v1/x", "/api/v1/../admin", "/api/v1/%2e%2e/admin",
    "/api/v1/a\\b", "/api/v1/a#b", "/api/v2/x", "/api/v1", "/x/api/v1/y", "", "/api/v1/a b", "/api/v1/works?x=1",
  ]) {
    assert.equal(validateOwnApiPath(bad).ok, false, bad);
  }
  assert.equal(validateOwnApiPath(undefined).ok, false);
});

test("Advisor guard token reads as Owner, is refused on irreversible APIs with 403, and revoked or non-advisor tokens stay 401", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "api-advisor-token-test", dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-api-advisor-token-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token: "test-owner-api-token" });
  if (!api) return t.skip("localhost listen is not permitted in this environment");
  const lease = (role) => guardTokens.issue({ agent_run_id: `run-${role}`, role });
  const tokenOf = async (l) => (await readFile(l.file, "utf8")).trim();
  const advisorLease = lease("advisor");
  const advisor = await tokenOf(advisorLease);
  const call = (method, path, authorization, body) => fetch(`${api.baseUrl}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  assert.equal((await call("GET", "/curation-runs", advisor)).status, 200);
  assert.equal((await call("GET", "/curation-runs")).status, 401);
  assert.equal((await call("GET", "/curation-runs", await tokenOf(lease("worker")))).status, 401);

  const workId = (await core.createWork(command({ title: "Advisor guarded", summary: "", size: "small", project_id: null }, "advisor-guarded"))).data.work_id;
  const snapshot = async () => (await (await call("GET", `/works/${workId}`, advisor)).json()).data;
  const before = await snapshot();
  const cases = [
    ["POST", `/works/${workId}/cancel`, ["cancel_work"]],
    ["DELETE", `/works/${workId}`, ["delete_work"]],
    ["PUT", "/settings/models", ["call_api"]],
    ["POST", "/advisor/actions", null, { type: "update_work", work_id: workId, title: "changed" }],
  ];
  for (const [method, path, expected, body] of cases) {
    const response = await call(method, path, advisor, method === "DELETE" ? undefined : body ?? {});
    assert.equal(response.status, 403, `${method} ${path}`);
    const error = (await response.json()).error;
    assert.equal(error.code, "advisor_action_required");
    if (expected) assert.deepEqual(error.details.alternative_actions, expected);
    else {
      assert.ok(error.details.alternative_actions.includes("update_work"));
      assert.ok(!error.details.alternative_actions.includes("call_api"));
    }
  }
  assert.deepEqual(await snapshot(), before);

  advisorLease.release();
  assert.equal((await call("GET", "/curation-runs", advisor)).status, 401);
  // Funnel 経由は loopback 扱いにならないので Advisor の token でも Owner にならない
  const fresh = await tokenOf(lease("advisor"));
  const funnel = await fetch(`${api.baseUrl}/api/v1/curation-runs`, { headers: { authorization: `Bearer ${fresh}`, "tailscale-funnel-request": "?1" } });
  assert.equal(funnel.status, 401);
});

test("a revoked guard token is 401 on an Owner route even when no API token is configured", async (t) => {
  const root = await tempDir(t, "owl-api-advisor-revoked-");
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const lease = guardTokens.issue({ agent_run_id: "run-advisor", role: "advisor" });
  const token = (await readFile(lease.file, "utf8")).trim();
  lease.release();
  const previous = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => { if (previous !== undefined) process.env.OWL_API_TOKEN = previous; });
  const api = await startTestHttpServer(t, { core: { ready: true }, webOut: root, owlRoot: root, guardTokens });
  if (!api) return t.skip("localhost listen is not permitted in this environment");
  const response = await fetch(`${api.baseUrl}/api/v1/curation-runs`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 401);
});

test("createOwnApiCaller calls the Owner API and classifies delivery failures", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "api-own-caller-test", dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-api-own-caller-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const token = "test-owner-api-token";
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) return t.skip("localhost listen is not permitted in this environment");
  const call = createOwnApiCaller({ apiBase: api.baseUrl, token: () => token });

  const current = await call({ method: "GET", path: "/api/v1/settings/models" });
  assert.equal(current.kind, "response");
  assert.equal(current.status, 200);
  const roles = current.body.data.roles.map(({ role, provider, model, effort }) => ({ role, provider, model, effort }));
  roles[0] = { ...roles[0], effort: roles[0].effort === "low" ? "high" : "low" };
  const updated = await call({ method: "PUT", path: "/api/v1/settings/models", body: envelope({ roles }, "own-caller") });
  assert.equal(updated.kind, "response");
  assert.equal(updated.status, 200);
  const after = await call({ method: "GET", path: "/api/v1/settings/models" });
  assert.equal(after.body.data.roles[0].effort, roles[0].effort);

  const net = await import("node:net");
  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const refused = await createOwnApiCaller({ apiBase: `http://127.0.0.1:${closedPort}`, token: () => token })({ method: "GET", path: "/api/v1/settings/models" });
  assert.equal(refused.kind, "not_sent");

  let foreignHits = 0;
  const foreign = net.createServer((socket) => { foreignHits += 1; socket.destroy(); });
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  for (const path of [`http://127.0.0.1:${foreign.address().port}/x`, `//127.0.0.1:${foreign.address().port}/x`]) {
    const other = await createOwnApiCaller({ apiBase: `http://127.0.0.1:${closedPort}`, token: () => token })({ method: "GET", path });
    assert.equal(other.kind, "not_sent");
  }
  assert.equal(foreignHits, 0);

  let received = 0;
  const silent = net.createServer((socket) => { received += 1; socket.on("data", () => {}); socket.on("error", () => {}); });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { silent.close(resolve); silent.closeAllConnections?.(); }));
  const hung = await createOwnApiCaller({ apiBase: `http://127.0.0.1:${silent.address().port}`, token: () => token, timeoutMs: 200 })({ method: "PUT", path: "/api/v1/settings/models", body: {} });
  assert.equal(hung.kind, "unknown");
  assert.equal(received, 1);
});

test("POST /advisor/workspace prepares the shared worktree only for a running Advisor session", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "api-advisor-workspace-test", providerClient: { createSession: async () => { throw new Error("unused"); } }, dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-api-advisor-workspace-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "init", "--initial-branch=main");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES ('conversation:ws', 'owner:default', NULL, 'web', 1, ?, ?)", now, now);
    for (const [id, status] of [["session-running", "running"], ["session-ended", "ended"]]) {
      tx.run("INSERT INTO advisor_sessions (id, status, conversation_id, last_activity_at, created_at, updated_at) VALUES (?, ?, 'conversation:ws', ?, ?, ?)", id, status, now, now, now);
    }
  });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token: "test-owner-api-token" });
  if (!api) return t.skip("localhost listen is not permitted in this environment");
  const tokenFor = async (role, runId) => (await readFile(guardTokens.issue({ agent_run_id: runId, role }).file, "utf8")).trim();
  const call = (authorization, body = {}) => fetch(`${api.baseUrl}/api/v1/advisor/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authorization}` },
    body: JSON.stringify(body),
  });

  const ok = await call(await tokenFor("advisor", "session-running"));
  assert.equal(ok.status, 200);
  const prepared = (await ok.json()).data;
  assert.equal(prepared.ok, true);
  assert.ok(git(root, "worktree", "list", "--porcelain").includes(`worktree ${prepared.worktree_path}`));

  assert.ok([401, 403].includes((await call("test-owner-api-token")).status));
  assert.ok([401, 403].includes((await call(await tokenFor("worker", "session-running"))).status));
  const ended = await call(await tokenFor("advisor", "session-ended"));
  assert.equal(ended.status, 404);
  assert.equal((await ended.json()).error.code, "advisor_session_not_found");
  const missing = await call(await tokenFor("advisor", "session-running"), { project_id: "project:missing" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "project_not_found");
});

test("POST /advisor/workspace is 503 dependency_unavailable on a Core without Advisor workspaces", async (t) => {
  const root = await tempDir(t, "owl-api-advisor-workspace-503-");
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core: { ready: true }, webOut: root, owlRoot: root, guardTokens });
  if (!api) return t.skip("localhost listen is not permitted in this environment");
  const token = (await readFile(guardTokens.issue({ agent_run_id: "session-x", role: "advisor" }).file, "utf8")).trim();
  const response = await fetch(`${api.baseUrl}/api/v1/advisor/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "dependency_unavailable");
});

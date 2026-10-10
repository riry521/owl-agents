import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../../packages/core/dist/index.js";
import { openDatabase } from "../../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../dist/core.js";
import { createOwlHttpServer } from "../dist/http.js";
import { callTool } from "../dist/memory-mcp.js";

const repoRoot = join(import.meta.dirname, "../../..");
const calls = [];
const memoryMode = "pages";
const fakeMemory = {
  search: async (input, ctx) => { calls.push({ op: "search", input, ctx }); return { items: [], stale: false, index_at: null, mode: "fts", note: "0 件。保管庫の状態は health で確認" }; },
  expand: async (input, ctx) => { calls.push({ op: "expand", input, ctx }); return { found: false, ambiguous: false, did_you_mean: [], stale: true }; },
  recall: async (input, ctx) => { calls.push({ op: "recall", input, ctx }); return { items: [], superseded: [], stale: false, index_at: null }; },
  mode: () => memoryMode,
  readIndex: async (input, ctx) => { calls.push({ op: "index", input, ctx }); return { found: false, did_you_mean: [], stale: false }; },
  page: async (input, ctx) => { calls.push({ op: "page", input, ctx }); return { found: false, did_you_mean: [], stale: false }; },
  searchPages: async (input, ctx) => { calls.push({ op: "pages/search", input, ctx }); return { items: [], stale: false, note: "0 件" }; },
  notifyChanged: () => {},
  health: async () => ({ storage: {}, index: {}, embedder: { state: "fake" }, injection: {}, probe_ms: 1 }),
  reindex: async (input) => ({ mode: input.mode }),
  stop: async () => {},
};

async function setup(t, { withMemory = true, withMemorySaver = true, startCore = false, unavailableKnowledgeStorage = false, withGuard = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-memory-http-"));
  if (unavailableKnowledgeStorage) writeFileSync(join(root, "knowledge"), "blocks the knowledge directory");
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  if (startCore) await core.start();
  else core.memory = withMemory ? fakeMemory : { stop: async () => {} };
  if (!withMemorySaver) core.memorySaver = undefined;
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const guardTokens = withGuard ? (await import("../dist/guard-tokens.js")).GuardTokenRegistry.open(join(root, "guard-tokens")) : undefined;
  const prior = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "mem-token";
  const http = createOwlHttpServer({ core: adapter, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root, ...(guardTokens ? { guardTokens } : {}) });
  t.after(async () => {
    await http.close().catch(() => {});
    if (prior === undefined) delete process.env.OWL_API_TOKEN; else process.env.OWL_API_TOKEN = prior;
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try { await http.listen(); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return null; }
    throw error;
  }
  const origin = `http://127.0.0.1:${http.server.address().port}`;
  const call = (op, body, headers = {}) => fetch(`${origin}/api/v1/memory/${op}`, {
    method: op === "health" || op === "mode" ? "GET" : "POST",
    headers: { authorization: "Bearer mem-token", "content-type": "application/json", ...headers },
    ...(op === "health" || op === "mode" ? {} : { body: JSON.stringify(body) }),
  });
  return { origin, call, root, guardTokens };
}

test("memory routes run through the adapter-wrapped Core", async (t) => {
  const api = await setup(t);
  if (!api) return;
  calls.length = 0;
  const search = await api.call("search", { query: "x", limit: 99, types: ["lesson"], scope: "all", include_raw: true }, { "x-owl-project-id": "P1" });
  assert.equal(search.status, 200);
  assert.equal((await search.json()).note, "0 件。保管庫の状態は health で確認");
  assert.equal(calls[0].input.limit, 30);
  assert.deepEqual(calls[0].input.types, ["lesson"]);
  assert.equal(calls[0].input.include_raw, true);
  assert.equal(calls[0].ctx.project_id, "P1");
  assert.equal(calls[0].ctx.caller, "owner");
  await api.call("search", { query: "x" });
  assert.equal(calls[1].input.limit, 8);

  assert.equal((await (await api.call("expand", { note: "n" })).json()).stale, true);
  assert.equal((await api.call("recall", { topic: "t", limit: 5 })).status, 200);
  const health = await (await api.call("health")).json();
  assert.equal(health.embedder.state, "fake");
  assert.equal(health.probe_ms, 1);
  assert.equal((await api.call("reindex", { mode: "full" })).status, 200);
});

test("memory-saving routes reach Core.memorySaver through ExternalCoreAdapter", async (t) => {
  const api = await setup(t);
  if (!api) return;

  const explicit = await api.call("save-explicit", { text: "adapter memory saver route", tags: ["adapter"] });
  assert.equal(explicit.status, 200);
  const explicitBody = await explicit.json();
  assert.equal(typeof explicitBody.path, "string");
  await access(join(api.root, "knowledge", explicitBody.path));

  const manual = await api.call("save-manual", {
    title: "Adapter manual snapshot",
    facts: ["saved through the adapter"],
    decisions: [],
    open_threads: [],
    related_work_ids: [],
    tags: ["adapter"],
  });
  assert.equal(manual.status, 200);
  const manualBody = await manual.json();
  assert.equal(typeof manualBody.path, "string");
  await access(join(api.root, "knowledge", manualBody.path));
});

test("saved explicit memory is searchable through ExternalCoreAdapter within five seconds", async (t) => {
  const api = await setup(t, { startCore: true });
  if (!api) return;

  const saved = await api.call("save-explicit", {
    text: "quartz skylark explicit memory search marker",
    tags: ["search-regression"],
  });
  assert.equal(saved.status, 200);
  const { path } = await saved.json();
  await access(join(api.root, "knowledge", path));

  const deadline = Date.now() + 5000;
  let found = false;
  while (Date.now() < deadline) {
    const response = await api.call("search", { query: "quartz skylark explicit memory search marker" });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.items.some((item) => item.path === path)) {
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(found, true, `not indexed within 5 seconds: ${path}`);
});

test("memory-saving routes return 503 when Core.memorySaver is unavailable", async (t) => {
  const api = await setup(t, { withMemorySaver: false });
  if (!api) return;

  for (const [op, body] of [
    ["save-explicit", { text: "memory saver unavailable" }],
    ["save-manual", { title: "snapshot", facts: [], decisions: [], open_threads: [], related_work_ids: [], tags: [] }],
  ]) {
    const response = await api.call(op, body);
    assert.equal(response.status, 503, op);
    assert.notEqual((await response.json()).error?.code, "server_error");
  }
});

test("memory-saving routes explain unavailable knowledge storage with 503", async (t) => {
  const api = await setup(t, { startCore: true, unavailableKnowledgeStorage: true });
  if (!api) return;

  const response = await api.call("save-explicit", { text: "cannot save while storage is unavailable" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error?.code, "storage_unavailable");
});

test("memory routes validate input, authenticate and answer 503 without core.memory", async (t) => {
  const api = await setup(t);
  if (!api) return;
  for (const [op, body] of [["search", {}], ["search", { query: "x", types: ["nope"] }], ["search", { query: "x", scope: "toString" }], ["expand", {}], ["recall", { limit: 0 }], ["reindex", { mode: "x" }]]) {
    assert.equal((await api.call(op, body)).status, 400, `${op} ${JSON.stringify(body)}`);
  }
  assert.equal((await api.call("search", { query: "x" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await api.call("toString", {})).status, 404);

  const bare = await setup(t, { withMemory: false });
  if (!bare) return;
  assert.equal((await bare.call("health")).status, 503);
});

test("owl-memory MCP: unreachable server and hostile tool names", async () => {
  const prior = process.env.OWL_GUARD_API_BASE;
  process.env.OWL_GUARD_API_BASE = "http://127.0.0.1:1";
  try {
    assert.deepEqual(await callTool("index", {}), { error: "owl_unreachable" });
    for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty", 1, null]) {
      assert.deepEqual(await callTool(name, {}), { error: "unknown_tool" }, String(name));
    }
  } finally {
    if (prior === undefined) delete process.env.OWL_GUARD_API_BASE; else process.env.OWL_GUARD_API_BASE = prior;
  }
});

test("page routes (index, page, pages/search, mode) validate input and pass the request context", async (t) => {
  const api = await setup(t);
  if (!api) return;
  calls.length = 0;
  assert.deepEqual(await (await api.call("mode")).json(), { mode: "pages" });
  assert.equal((await api.call("index", {}, { "x-owl-project-id": "P1" })).status, 200);
  assert.equal(calls[0].ctx.project_id, "P1");
  assert.equal((await api.call("page", { page: "テーマ", sections: ["概要"] })).status, 200);
  assert.deepEqual(calls[1].input, { page: "テーマ", sections: ["概要"] });
  assert.equal((await api.call("pages/search", { query: "x", include_work_log: true })).status, 200);
  assert.deepEqual(calls[2].input, { query: "x", include_work_log: true });
  for (const [op, body] of [["page", {}], ["page", { page: "p", sections: [1] }], ["pages/search", {}], ["pages/search", { query: "x", include_work_log: "yes" }]]) {
    assert.equal((await api.call(op, body)).status, 400, `${op} ${JSON.stringify(body)}`);
  }
  assert.equal((await api.call("page", { page: "p" }, { authorization: "Bearer wrong" })).status, 401);
});

test("owl-memory MCP lists index/page/search in pages mode (descriptions within 350 tokens) and routes search to pages/search", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const env = { ...process.env, OWL_GUARD_API_BASE: `${api.origin}/api/v1`, OWL_API_TOKEN: "mem-token", OWL_GUARD_TOKEN_FILE: "" };
  for (const name of ["OWL_AGENT_RUN_ID", "OWL_ROLE", "OWL_WORK_ID", "OWL_TASK_ID", "OWL_PROJECT_ID"]) delete env[name];
  const input = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "資料" } } }].map((m) => JSON.stringify(m)).join("\n") + "\n";
  calls.length = 0;
  // Async: the fake Core answers from this very process, so the event loop must stay free.
  const child = spawn(process.execPath, [join(repoRoot, "apps/server/dist/memory-mcp.js")], { env });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end(input);
  await new Promise((resolve) => child.on("close", resolve));
  const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
  const tools = lines[1].result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["index", "page", "search"]);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
  const { estimatePageTokens } = await import("../../../packages/core/dist/memory/page-format.js");
  const total = tools.reduce((sum, tool) => sum + estimatePageTokens(tool.description), 0);
  assert.ok(total <= 350, `descriptions total ${total} tokens`);
  assert.deepEqual(calls.map((c) => c.op), ["pages/search"]);
  assert.equal(calls[0].input.query, "資料");
  assert.equal(calls[0].ctx.caller, "owner");
});

test("owl-memory MCP over stdio lists three read-only page tools; memory-cli reports unreachable", async () => {
  const input = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]
    .map((m) => JSON.stringify(m)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [join(repoRoot, "apps/server/dist/memory-mcp.js")], { input, encoding: "utf8" });
  const lines = run.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  const tools = lines[1].result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["index", "page", "search"]);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true && tool.description.length > 0));

  const cli = spawnSync(process.execPath, [join(repoRoot, "scripts/memory-cli.mjs"), "health"], { encoding: "utf8", env: { ...process.env, OWL_GUARD_API_BASE: "http://127.0.0.1:1" } });
  assert.deepEqual(JSON.parse(cli.stdout), { error: "owl_unreachable" });
});

test("real Core: health has injection, guard tokens authenticate per role, reindex is owner-only", async (t) => {
  const { GuardTokenRegistry } = await import("../dist/guard-tokens.js");
  const root = await mkdtemp(join(tmpdir(), "owl-memory-real-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  const prior = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "mem-token";
  const http = createOwlHttpServer({ core: adapter, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root, guardTokens });
  t.after(async () => {
    await http.close().catch(() => {});
    if (prior === undefined) delete process.env.OWL_API_TOKEN; else process.env.OWL_API_TOKEN = prior;
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try { await http.listen(); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("listen not permitted");
    throw error;
  }
  const origin = `http://127.0.0.1:${http.server.address().port}`;
  const call = (op, body, token) => fetch(`${origin}/api/v1/memory/${op}`, {
    method: op === "health" ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(op === "health" ? {} : { body: JSON.stringify(body) }),
  });

  const owner = await (await call("health", undefined, "mem-token")).json();
  for (const key of ["storage", "index", "embedder", "injection", "probe_ms"]) assert.ok(key in owner, key);

  const seen = [];
  const search = core.memory.search.bind(core.memory);
  core.memory.search = async (input, ctx) => { seen.push(ctx); return search(input, ctx); };
  const lease = guardTokens.issue({ agent_run_id: "run-1", role: "worker" });
  const token = readFileSync(lease.file, "utf8");
  for (const [op, body] of [["search", { query: "x" }], ["expand", { note: "n" }], ["recall", {}], ["health"]]) {
    assert.equal((await call(op, body, token)).status, 200, op);
  }
  assert.equal(seen[0].caller, "worker");
  assert.equal(seen[0].agent_run_id, "run-1");
  assert.equal((await call("reindex", { mode: "diff" }, token)).status, 401);

  lease.release();
  for (const bad of [token, "not-a-token"]) assert.equal((await call("search", { query: "x" }, bad)).status, 401);
});

/** One stdio session of the built memory-mcp.js as `role`, with its guard token file; returns the JSON-RPC replies by id. */
async function mcpSession(origin, role, tokenFile, messages) {
  const env = { ...process.env, OWL_GUARD_API_BASE: `${origin}/api/v1`, OWL_GUARD_TOKEN_FILE: tokenFile, OWL_ROLE: role };
  delete env.OWL_API_TOKEN;
  const child = spawn(process.execPath, [join(repoRoot, "apps/server/dist/memory-mcp.js")], { env });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await new Promise((resolve) => child.on("close", resolve));
  return Object.fromEntries(stdout.trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.id, r]));
}

test("append is Advisor-only: HTTP refuses other roles and bad input without touching the page; MCP lists and routes it only for advisor", async (t) => {
  const { createHash } = await import("node:crypto");
  const { estimatePageTokens } = await import("../../../packages/core/dist/memory/page-format.js");
  const api = await setup(t, { startCore: true, withGuard: true });
  if (!api) return;
  const project = "01HZZZZZZZZZZZZZZZZZZZZZZP";
  const lease = (role) => api.guardTokens.issue({ agent_run_id: `run-${role}`, role });
  const leases = Object.fromEntries(["advisor", "worker", "manager"].map((role) => [role, lease(role)]));
  const post = (body, token) => api.call("append", body, token === null ? { authorization: "" } : { authorization: `Bearer ${token ?? readFileSync(leases.advisor.file, "utf8")}` });
  const input = { project_id: project, section: "落とし穴", text: "月末は固定日時を渡す", theme: "テストの注意" };

  const ok = await post(input);
  assert.equal(ok.status, 200);
  const done = await ok.json();
  assert.equal(done.status, "appended");
  const file = join(api.root, "knowledge", done.page);
  const text = readFileSync(file, "utf8");
  assert.match(text, /^- 月末は固定日時を渡す（会話\d{4}-\d{2}-\d{2}-1） <!-- owl:new /mu);
  assert.equal((await (await post(input)).json()).status, "duplicate");

  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = sha();
  for (const body of [{ ...input, section: "関連ページ" }, { ...input, section: "更新履歴" }, { ...input, section: "未知" }, { ...input, text: "" }, { ...input, text: "  \n " }, { project_id: project, text: "x" }, { project_id: project, section: "概要" }]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const role of ["worker", "manager"]) assert.equal((await post({ ...input, text: "別の行" }, readFileSync(leases[role].file, "utf8"))).status, 403, role);
  assert.equal((await post({ ...input, text: "別の行" }, "mem-token")).status, 403, "owner");
  assert.ok((await post({ ...input, text: "別の行" }, null)).status >= 400, "no token");
  assert.equal(sha(), before);

  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "append", arguments: { ...input, text: "MCP 経由の追記" } } };
  const advisor = await mcpSession(api.origin, "advisor", leases.advisor.file, [list, call]);
  assert.deepEqual(advisor[2].result.tools.map((tool) => tool.name), ["index", "page", "search", "append"]);
  assert.ok(estimatePageTokens(advisor[2].result.tools.map((tool) => tool.description).join("")) <= 350);
  assert.equal(JSON.parse(advisor[3].result.content[0].text).status, "appended");
  assert.match(readFileSync(file, "utf8"), /- MCP 経由の追記（会話/u);

  const after = sha();
  for (const role of ["worker", "manager"]) {
    const replies = await mcpSession(api.origin, role, leases[role].file, [list, call]);
    assert.deepEqual(replies[2].result.tools.map((tool) => tool.name), ["index", "page", "search"], role);
    assert.deepEqual(JSON.parse(replies[3].result.content[0].text), { error: "unknown_tool" }, role);
  }
  assert.equal(sha(), after);
});

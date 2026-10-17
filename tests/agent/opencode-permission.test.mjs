// opencode permission handling: the rule list, tool-call translation, the hook-backed responder and the
// pre-send checks of a turn, driven by the fake opencode and the real apps/server/dist/permission-hook.js.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { OpencodePermissionResponder, runOpencodeTurn, startOpencodeServer } from "../../packages/agent-runtime/dist/index.js";
import { normalizeOpencodeToolCall, opencodePermissionRules, opencodeServeEnv } from "../../packages/shared/dist/index.js";
import { readFakeOpencodeLog, startFakeOwlApi, writeFakeOpencode } from "../helpers/fake-opencode.mjs";
import { tempDir } from "../helpers/temp.mjs";

const model = { providerID: "some-provider", id: "some-model" };
const owlRoot = process.cwd();

test("opencodePermissionRules starts with ask-all and only the librarian gets edit/webfetch/websearch denies", () => {
  const worker = opencodePermissionRules("worker");
  assert.deepEqual(worker[0], { action: "*", resource: "*", effect: "ask" });
  assert.deepEqual(worker.slice(1).map((rule) => [rule.action, rule.resource, rule.effect]), ["question", "subagent", "skill", "execute"].map((action) => [action, "*", "deny"]));
  const librarian = opencodePermissionRules("librarian");
  assert.deepEqual(librarian.slice(0, worker.length), worker);
  assert.deepEqual(librarian.slice(worker.length).map((rule) => [rule.action, rule.effect]), [["edit", "deny"], ["webfetch", "deny"], ["websearch", "deny"]]);
});

test("normalizeOpencodeToolCall maps each tool to the name and keys the hook reads and keeps the original keys", () => {
  const norm = (name, input) => normalizeOpencodeToolCall(name, input, "/cwd");
  assert.deepEqual(norm("read", { path: "/a" }), { tool_name: "Read", tool_input: { path: "/a", file_path: "/a" }, cwd: "/cwd", hooked: true });
  assert.deepEqual(norm("write", { path: "/a", content: "c" }).tool_input, { path: "/a", file_path: "/a", content: "c" });
  assert.deepEqual(norm("edit", { path: "/a", oldString: "o", newString: "n", replaceAll: true }), {
    tool_name: "Edit",
    tool_input: { path: "/a", oldString: "o", newString: "n", replaceAll: true, file_path: "/a", old_string: "o", new_string: "n", replace_all: true },
    cwd: "/cwd",
    hooked: true,
  });
  assert.deepEqual(norm("patch", { patchText: "p" }), { tool_name: "apply_patch", tool_input: { patchText: "p", patch: "p" }, cwd: "/cwd", hooked: true });
  assert.deepEqual(norm("shell", { command: "ls", workdir: "/w" }), { tool_name: "Bash", tool_input: { command: "ls", workdir: "/w" }, cwd: "/w", hooked: true });
  assert.equal(norm("shell", { command: "ls" }).cwd, "/cwd");
  for (const [name, expected] of [["glob", "Glob"], ["grep", "Grep"], ["webfetch", "WebFetch"], ["websearch", "WebSearch"]]) {
    assert.deepEqual(norm(name, { x: 1 }), { tool_name: expected, tool_input: { x: 1 }, cwd: "/cwd", hooked: true });
  }
  assert.deepEqual(norm("owl-memory_search", { q: 1 }), { tool_name: "mcp__owl-memory__search", tool_input: { q: 1 }, cwd: "/cwd", hooked: true });
  assert.deepEqual(norm("todowrite", { a: 1 }), { tool_name: "todowrite", tool_input: { a: 1 }, cwd: "/cwd", hooked: false });
  assert.equal(norm("toString", {}).hooked, false);
});

/**
 * A fake opencode serve with one session. The hook runs for real against a fake Owl API that allows only
 * paths under the temp root. `scenario` is a function of that root.
 */
async function setup(t, { scenario = () => [], role = "worker", saved = [], sessionPermissions, hookOwlRoot = owlRoot, hookTimeoutMs } = {}) {
  const root = await tempDir(t, "owl-opencode-perm-");
  const api = await startFakeOwlApi(t, {
    guard: (payload) => (String(payload.tool_input?.file_path ?? "").startsWith(root) ? { allowed: true } : { allowed: false, message: "outside the write scope" }),
  });
  if (!api) return null;
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, randomBytes(8).toString("hex"), { mode: 0o600 });
  const executable = await writeFakeOpencode(root);
  const logPath = path.join(root, "log.jsonl");
  const runEnv = { PATH: process.env.PATH ?? "", OWL_AGENT_ROLE: role, OWL_GUARD_API_BASE: api.baseUrl, OWL_GUARD_TOKEN_FILE: tokenFile, OWL_AGENT_CWD: root };
  const env = opencodeServeEnv({
    env: { PATH: process.env.PATH ?? "", FAKE_OPENCODE_LOG: logPath, FAKE_OPENCODE_SCENARIO: JSON.stringify(scenario(root)), FAKE_OPENCODE_SAVED: JSON.stringify(saved) },
    password: randomBytes(12).toString("hex"),
    runDir: path.join(root, "run"),
    configContent: "{}",
  });
  const server = await startOpencodeServer({ executable, cwd: root, env, eventStallMs: 10_000 });
  t.after(() => server.stop(1000));
  const events = server.client.events(new AbortController().signal)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, "server.connected");
  const created = await server.client.request("POST", "/api/session", {
    title: "t",
    agent: "build",
    model,
    location: { directory: root },
    permissions: sessionPermissions ?? opencodePermissionRules(role),
  });
  const responder = new OpencodePermissionResponder({ client: server.client, owlRoot: hookOwlRoot, cwd: root, env: runEnv, hookTimeoutMs });
  const turn = (text = "hello") => runOpencodeTurn({ client: server.client, events, responder, role, sessionId: created.data.id, projectId: created.data.projectID, text });
  const requests = async (suffix) => (await readFakeOpencodeLog(logPath)).filter((entry) => entry.type === "request" && entry.method === "POST" && entry.path.endsWith(suffix));
  const replies = async () => (await readFakeOpencodeLog(logPath)).filter((entry) => entry.type === "request" && /\/permission\/[^/]+\/reply$/u.test(entry.path)).map((entry) => entry.body);
  const guardCalls = () => api.requests.filter((request) => request.path === "/api/v1/guard/check");
  return { root, api, responder, turn, requests, replies, guardCalls, session: created.data };
}

const writeStep = (file) => ({ op: "tool", name: "write", action: "edit", resources: ["*"], input: { path: file, content: "x" } });
const finish = [{ op: "text", chunks: ["done"] }, { op: "succeed" }];

test("a write outside the write scope is rejected with the guard's reason and one inside is answered once", async (t) => {
  const ctx = await setup(t, { scenario: (root) => [writeStep("/outside/out.txt"), writeStep(path.join(root, "in.txt")), ...finish] });
  if (!ctx) return t.skip("localhost listen is unavailable");
  const result = await ctx.turn();
  assert.equal(result.error, null);
  assert.equal(result.text, "done");
  const [outside, inside] = await ctx.replies();
  assert.equal(outside.decision, "reject");
  assert.match(outside.message, /outside the write scope/u);
  assert.deepEqual(inside, { decision: "once" });
  assert.equal(ctx.guardCalls()[0].body.payload.tool_name, "Write");
  assert.equal(ctx.guardCalls().length, 2);
});

test("librarian writes are rejected by the hook even inside the scope", async (t) => {
  const ctx = await setup(t, { role: "librarian", scenario: (root) => [writeStep(path.join(root, "in.txt")), ...finish] });
  if (!ctx) return t.skip("localhost listen is unavailable");
  const result = await ctx.turn();
  assert.equal(result.error, null);
  const [reply] = await ctx.replies();
  assert.equal(reply.decision, "reject");
  assert.ok(reply.message.length > 0);
  assert.equal(ctx.guardCalls().length, 0);
});

/** Drives the responder alone with a stub client, a tool the events already described, and the real hook. */
async function responderFixture(t, options = {}) {
  const api = await startFakeOwlApi(t, { guard: () => ({ allowed: true }) });
  if (!api) return null;
  const root = await tempDir(t, "owl-opencode-responder-");
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, "token", { mode: 0o600 });
  const posts = [];
  const client = { request: async (method, requestPath, body) => { if (method === "POST") posts.push({ path: requestPath, body }); } };
  const env = { PATH: process.env.PATH ?? "", OWL_AGENT_ROLE: "worker", OWL_GUARD_API_BASE: api.baseUrl, OWL_GUARD_TOKEN_FILE: tokenFile, OWL_AGENT_CWD: root };
  const responder = new OpencodePermissionResponder({ client, owlRoot, cwd: root, env, toolLookupWaitMs: 20, ...options });
  responder.noteTool("call_1", { name: "write", input: { path: path.join(root, "a.txt"), content: "x" } });
  const ask = (overrides = {}) => responder.handleAsked({ id: "per_1", sessionID: "ses_1", action: "edit", resources: ["*"], save: false, source: { type: "tool", messageID: "msg_1", id: "call_1" }, ...overrides });
  return { api, responder, posts, ask, root };
}

test("asks that cannot be judged are rejected: no source, a denied action, a missing tool, a late or unreadable hook", async (t) => {
  const fixture = await responderFixture(t);
  if (!fixture) return t.skip("localhost listen is unavailable");
  await fixture.ask({ id: "per_a", source: undefined });
  await fixture.ask({ id: "per_b", source: { type: "message", id: "call_1" } });
  await fixture.ask({ id: "per_c", action: "question" });
  await fixture.ask({ id: "per_d", source: { type: "tool", messageID: "msg_1", id: "call_unknown" } });
  assert.deepEqual(fixture.posts.map((post) => post.body.decision), ["reject", "reject", "reject", "reject"]);
  assert.deepEqual(fixture.posts.map((post) => post.path), ["a", "b", "c", "d"].map((letter) => `/api/session/ses_1/permission/per_${letter}/reply`));
  assert.equal(fixture.api.requests.length, 0);

  const late = await responderFixture(t, { hookTimeoutMs: 1 });
  await late.ask();
  assert.equal(late.posts[0].body.decision, "reject");
  assert.match(late.posts[0].body.message, /did not finish/u);

  const fakeRoot = await tempDir(t, "owl-opencode-fake-hook-");
  await mkdir(path.join(fakeRoot, "apps/server/dist"), { recursive: true });
  await writeFile(path.join(fakeRoot, "apps/server/dist/permission-hook.js"), "process.stdout.write('not json');\n", "utf8");
  const unreadable = await responderFixture(t, { owlRoot: fakeRoot });
  await unreadable.ask();
  assert.equal(unreadable.posts[0].body.decision, "reject");
  assert.match(unreadable.posts[0].body.message, /could not be read/u);
});

test("asks with the same source id run the hook once and get the same reply", async (t) => {
  const fixture = await responderFixture(t);
  if (!fixture) return t.skip("localhost listen is unavailable");
  fixture.responder.noteTool("call_1", { name: "write", input: { path: "/outside/x", content: "x" } });
  const guardOutside = fixture.api.requests;
  await Promise.all([fixture.ask({ id: "per_1", action: "external_directory" }), fixture.ask({ id: "per_2", action: "edit" })]);
  await fixture.ask({ id: "per_3", action: "edit" });
  assert.deepEqual(fixture.posts.map((post) => post.body), Array(3).fill(fixture.posts[0].body));
  assert.equal(fixture.posts[0].body.decision, "once");
  assert.equal(guardOutside.filter((request) => request.path === "/api/v1/guard/check").length, 1);
});

test("a turn fails and interrupts on a form request, a tool success never answered once, or a reply the driver did not send", async (t) => {
  const cases = [
    ["opencode_unsupported_request", [{ op: "emit", type: "session.form.asked" }, { op: "wait_interrupt" }]],
    ["opencode_permission_bypass", [{ op: "emit", type: "session.tool.input.started", data: { id: "call_x", name: "write" } }, { op: "emit", type: "session.tool.success", data: { id: "call_x" } }, { op: "wait_interrupt" }]],
    ["opencode_permission_bypass", [{ op: "emit", type: "session.tool.success", data: { id: "call_never_seen" } }, { op: "wait_interrupt" }]],
    ["opencode_permission_reply_failed", [{ op: "emit", type: "permission.asked", data: { id: "per_missing", action: "edit", resources: ["*"], save: false } }, { op: "succeed" }, { op: "wait_interrupt" }]],
    ["opencode_unexpected_permission_reply", [{ op: "emit", type: "permission.replied", data: { requestID: "per_unknown" } }, { op: "wait_interrupt" }]],
  ];
  for (const [type, scenario] of cases) {
    const ctx = await setup(t, { scenario: () => scenario });
    if (!ctx) return t.skip("localhost listen is unavailable");
    const result = await ctx.turn();
    assert.equal(result.error?.type, type);
    assert.equal((await ctx.requests("/interrupt")).length, 1, type);
  }
});

test("a turn does not send when this project has saved permissions or the session's permissions changed", async (t) => {
  const saved = await setup(t, { saved: [{ id: "sav_1", projectID: "proj_1" }], scenario: () => finish });
  if (!saved) return t.skip("localhost listen is unavailable");
  const refused = await saved.turn();
  assert.equal(refused.error?.type, "opencode_saved_permissions");
  assert.equal((await saved.requests("/prompt")).length, 0);

  const other = await setup(t, { saved: [{ id: "sav_2", projectID: "proj_other" }], scenario: () => finish });
  const result = await other.turn("exact text");
  assert.equal(result.error, null);
  assert.equal(result.text, "done");
  const prompts = await other.requests("/prompt");
  assert.deepEqual(prompts.map((prompt) => prompt.body), [{ text: "exact text" }]);

  const changed = await setup(t, { sessionPermissions: [...opencodePermissionRules("worker"), { action: "*", resource: "*", effect: "allow" }], scenario: () => finish });
  const changedResult = await changed.turn();
  assert.equal(changedResult.error?.type, "opencode_permissions_changed");
  assert.equal((await changed.requests("/prompt")).length, 0);
});
